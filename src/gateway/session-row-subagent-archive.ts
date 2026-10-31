import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { prepareSubagentArchiveSessionListRead } from "../agents/subagents/registry/subagent-registry-state.js";
import { createSessionRowChildActivity } from "./session-row-child-activity.js";
import { createSessionRowChildVisibility } from "./session-row-child-visibility.js";
import type {
  SessionRowReadView,
  SessionRowSubagentArchiveRead,
} from "./session-row-prepared-read.js";
import * as records from "./session-row-projection-record.js";
import { buildSessionSwarmSummary } from "./session-swarm-summary.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";

export class SessionRowSubagentArchivePending extends Error {
  constructor() {
    super("Subagent history changed; prepare the current archive before presenting rows");
  }
}

export async function withCurrentSessionRowSubagentArchive<T>(read: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof SessionRowSubagentArchivePending)) {
        throw error;
      }
    }
  }
}

/** Historical facts belong to this read, never the projection's resident registry index. */
export function prepareSessionRowSubagentArchive(scope?: {
  kind: "sessions" | "children";
  sessionKeys: readonly string[];
}): SessionRowSubagentArchiveRead | Promise<SessionRowSubagentArchiveRead> {
  const archive = prepareSubagentArchiveSessionListRead(
    scope?.kind === "children"
      ? { kind: "children", sessionKeys: scope.sessionKeys }
      : scope
        ? { kind: "sessions", sessionKeys: scope.sessionKeys, descendants: true }
        : { kind: "all" },
  );
  return archive instanceof Promise
    ? archive.then((read) => projectSessionRowSubagentArchive(read, scope))
    : projectSessionRowSubagentArchive(archive, scope);
}

function projectSessionRowSubagentArchive(
  archive: Awaited<ReturnType<typeof prepareSubagentArchiveSessionListRead>>,
  scope?: { kind: "sessions" | "children"; sessionKeys: readonly string[] },
): SessionRowSubagentArchiveRead {
  let source: SessionListRowContext | undefined;
  let prepared: SessionListRowContext | undefined;
  function context(current: SessionListRowContext): SessionListRowContext {
    if (!archive.isCurrent()) {
      throw new SessionRowSubagentArchivePending();
    }
    archive.assertCurrent();
    if (archive.runs.size === 0) {
      return current;
    }
    if (source !== current) {
      const subagentRuns =
        prepared && source?.subagentRuns.revision === current.subagentRuns.revision
          ? prepared.subagentRuns.atTime(Date.now())
          : scope
            ? buildSubagentSessionListReadIndex(
                Date.now(),
                scope.sessionKeys,
                archive.readSessionRuns(scope.sessionKeys, scope.kind),
              )
            : buildSubagentRunReadIndexFromRuns({
                ...current.subagentRuns.inputs,
                runs: new Map([...archive.runs, ...current.subagentRuns.inputs.runs]),
                now: Date.now(),
              });
      source = current;
      prepared = {
        ...current,
        transientSubagentRuns: true,
        subagentRuns,
        subagentRunsByChildSessionKey: subagentRuns.runsByChildSessionKey,
      };
    }
    return prepared!;
  }
  return {
    isCurrent: archive.isCurrent,
    assertCurrent: () => archive.assertCurrent(),
    context,
    read(owner: SessionRowReadView): SessionRowReadView {
      if (archive.runs.size === 0) {
        return owner;
      }
      const descriptions = new WeakMap<records.MaterializedRow, records.MaterializedRow>();
      const childActivity = createSessionRowChildActivity();
      const childVisibility = createSessionRowChildVisibility();
      const describe = (record: records.MaterializedRow) => {
        const previous = descriptions.get(record);
        if (previous) {
          return previous;
        }
        const rowContext = context(owner.state.rowContext);
        const swarm = buildSessionSwarmSummary(
          rowContext.subagentRuns.swarmRunsByRequesterSessionKey.get(record.key) ?? [],
          record.key,
          record.agentId,
          { includeChildren: true },
        );
        const next =
          record.materialized.row.swarm === undefined && swarm === undefined
            ? record
            : {
                ...record,
                materialized: {
                  ...record.materialized,
                  row: { ...record.materialized.row, swarm },
                },
              };
        descriptions.set(record, next);
        descriptions.set(next, next);
        return next;
      };
      return {
        ...owner,
        get state() {
          const state = owner.state;
          return { ...state, rowContext: context(state.rowContext) };
        },
        describe(...args) {
          const record = owner.describe(...args);
          return record && describe(record);
        },
        readChildVisibility: (...args) => childVisibility.read(...args),
        readChildActivity(record, now, excluded, revision) {
          return childActivity.read(
            record,
            context(owner.state.rowContext),
            now,
            excluded,
            revision,
          );
        },
        present(record, options) {
          const rowContext = context(owner.state.rowContext);
          return records.present(describe(record), rowContext, options);
        },
      };
    },
  };
}
