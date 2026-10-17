import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { SessionListViewCache } from "./session-list-view-cache.js";
import type * as records from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type PublicationRows = WeakMap<
  records.MaterializedRow["materialized"],
  {
    facts: readonly unknown[];
    views: Map<string, Readonly<GatewaySessionRow>>;
    target: SessionSharingTarget;
  }
>;
type Publication = {
  factsRevision: number;
  rows: PublicationRows;
  lists: SessionListViewCache;
};
export type PublicationView = () => Publication;

const publications = new WeakMap<
  SessionRowProjection,
  {
    revision: object | undefined;
    cfg: SessionRowProjection["state"]["cfg"];
    identityRevision: object | undefined;
  } & Publication
>();
/** Retained comparison witnesses follow the projection lifecycle, independently of readers. */
export function prepareSessionRowPublicationView(
  projection: SessionRowProjection,
): PublicationView {
  return () => {
    const { revision, cfg, rowContext } = projection.state;
    const identityRevision = rowContext.identityProjection?.revision;
    let publication = publications.get(projection);
    if (!publication) {
      publication = {
        revision,
        cfg,
        identityRevision,
        factsRevision: 0,
        rows: new WeakMap(),
        lists: new SessionListViewCache(),
      };
      publications.set(projection, publication);
      const retained = publication;
      projection.onSelectionChange((change) => {
        if (change.kind === "reset") {
          if (retained.lists.hasSidebarBaselines()) {
            emitTrustedDiagnosticEvent({
              type: "sessions.list.baseline.retired",
              cause: "selection-reset",
            });
          }
          retained.lists.clear();
          return;
        }
        // Unaffected immutable vectors remain comparison witnesses after selection retires.
        retained.revision = undefined;
        for (const list of retained.lists.values()) {
          list.selection = undefined;
          retained.lists.update(list);
        }
      });
      projection.onFactsChange((change) => {
        retained.factsRevision++;
        // Facts can change without retiring the view (for example, broad run activity).
        // Keep its comparison history; selection/config/identity resets still retire the view.
        for (const list of retained.lists.values()) {
          if (change.kind === "reset" || list.rows?.some((row) => row.key === change.key)) {
            retained.lists.retireRows(list);
          }
        }
      });
    } else {
      // Exact row publications cannot mask a preceding profile/configuration invalidation.
      if (
        (publication.revision !== undefined && publication.revision !== revision) ||
        publication.cfg !== cfg ||
        publication.identityRevision !== identityRevision
      ) {
        if (publication.lists.hasSidebarBaselines()) {
          emitTrustedDiagnosticEvent({
            type: "sessions.list.baseline.retired",
            cause:
              publication.cfg !== cfg
                ? "config"
                : publication.identityRevision !== identityRevision
                  ? "identity"
                  : "projection-revision",
          });
        }
        publication.lists.clear();
      }
      publication.revision = revision;
      publication.cfg = cfg;
      publication.identityRevision = identityRevision;
    }
    return publication;
  };
}
