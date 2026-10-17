import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { SessionEntrySelection, SessionListFilteredEntries } from "./session-list-filters.js";
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
type PublicationList = {
  rows?: GatewaySessionRow[];
  rowHistory?: GatewaySessionRow[][];
  sidebar?: boolean;
  selection?: SessionEntrySelection;
  selectedAt?: number;
  activityExpiresAt?: number;
  partitions?: WeakMap<object, SessionListFilteredEntries>;
};
type Publication = {
  factsRevision: number;
  rows: PublicationRows;
  lists: Map<string, PublicationList>;
};
export type PublicationView = () => Publication;

export function hasSidebarBaseline(view: PublicationList): boolean {
  return view.sidebar === true && (view.rows !== undefined || Boolean(view.rowHistory?.length));
}

function hasSidebarBaselines(lists: Publication["lists"]): boolean {
  for (const view of lists.values()) {
    if (hasSidebarBaseline(view)) {
      return true;
    }
  }
  return false;
}

const SIDEBAR_ROW_HISTORY_LIMIT = 32;

export function retainSidebarRows(rows: GatewaySessionRow[], history: GatewaySessionRow[][] = []) {
  if (history.push(rows) > SIDEBAR_ROW_HISTORY_LIMIT) {
    history.shift();
    emitTrustedDiagnosticEvent({
      type: "sessions.list.baseline.retired",
      cause: "history-evicted",
    });
  }
  return history;
}

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
        lists: new Map(),
      };
      publications.set(projection, publication);
      const retained = publication;
      projection.onSelectionChange((change) => {
        if (change.kind === "reset") {
          if (hasSidebarBaselines(retained.lists)) {
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
        }
      });
      projection.onFactsChange((change) => {
        retained.factsRevision++;
        // Facts can change without retiring the view (for example, broad run activity).
        // Keep its comparison history; selection/config/identity resets still retire the view.
        for (const list of retained.lists.values()) {
          if (change.kind === "reset" || list.rows?.some((row) => row.key === change.key)) {
            if (list.rows?.[0]?.rowMode === "sidebar") {
              list.rowHistory = retainSidebarRows(list.rows, list.rowHistory);
            }
            list.rows = undefined;
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
        if (hasSidebarBaselines(publication.lists)) {
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
