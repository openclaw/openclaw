import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  identity,
  selectionRow,
  type Row,
  type SelectionRow,
} from "./session-row-projection-record.js";
import type { createSessionRowRefresh } from "./session-row-projection-refresh.js";
import type { prepareSessionRowScopes } from "./session-row-scope.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";

/** A projection facet: topology hydrates it; committed row publications maintain it. */
export function createSessionRowRecents(owner: {
  rows: ReadonlyMap<string, Row>;
  state: () => {
    cfg: OpenClawConfig;
    scope: ReturnType<typeof prepareSessionRowScopes>;
    context: SessionListRowContext;
  };
  refresh: () => Pick<
    ReturnType<typeof createSessionRowRefresh>,
    "prepareSelection" | "selectionNeedsPreparation"
  >;
  assertActive: () => void;
}) {
  let selection: ReturnType<typeof createSessionRowSelection<SelectionRow>> | undefined;
  const pending = new Set<string>();
  const track = (row: Row) => {
    const id = identity(row);
    if (
      !row.storedEntry ||
      row.sharingEntry !== row.storedEntry ||
      row.entryAcquisitionPending ||
      row.unresolvedDatabaseFacts
    ) {
      pending.add(id);
    } else {
      pending.delete(id);
    }
  };
  return {
    track,
    update(row: Row, removed = false) {
      const id = identity(row);
      if (removed) {
        pending.delete(id);
      } else {
        track(row);
      }
      selection?.change({
        kind: "row",
        id,
        key: row.key,
        agentId: row.agentId,
        row: removed ? undefined : selectionRow(row),
      });
    },
    reset() {
      selection = undefined;
    },
    async candidates(this: void, profileIds: ReadonlySet<string>) {
      const options = { metadataOnly: true };
      const candidateIds = () => pending;
      const refresh = owner.refresh();
      do {
        await refresh.prepareSelection(options, candidateIds);
      } while (refresh.selectionNeedsPreparation(options, candidateIds));
      owner.assertActive();
      if (!selection) {
        const { cfg, scope } = owner.state();
        selection = createSessionRowSelection(
          cfg,
          scope.select({}),
          false,
          () => owner.state().context,
          true,
        );
        for (const row of owner.rows.values()) {
          const selected = selectionRow(row);
          if (selected) {
            selection.add(selected);
          }
        }
      }
      return selection.createdEntries(profileIds);
    },
    dispose() {
      selection = undefined;
      pending.clear();
    },
  };
}
