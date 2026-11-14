import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { planInPlaceSessionMessageCut } from "./session-message-cut-plan.js";
import { createSessionMessageCutReader } from "./session-message-cut-target.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import type { InternalSessionEntry } from "./types.js";

/**
 * Best-effort semantic precheck before a local workspace is retired.
 *
 * Reads are indexed and read-only, so a lagging active-path projection defers
 * to the committing transaction, which owns reconciliation and revalidation.
 */
export function refuseInPlaceSessionMessageCut(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  entry: InternalSessionEntry,
  intent: SessionMessageCutIntent & { mode: "rewind" | "switch" },
  sourceRepositoryWorkspaceId?: string,
): Exclude<SessionMessageCutResult, { status: "created" }> | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const reader = createSessionMessageCutReader(database, resolved.sessionId, {
      reconcile: false,
    });
    if (!reader) {
      return undefined;
    }
    const plan = planInPlaceSessionMessageCut(entry, reader, intent, sourceRepositoryWorkspaceId);
    return plan.status === "prepared" ? undefined : plan;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : undefined;
}
