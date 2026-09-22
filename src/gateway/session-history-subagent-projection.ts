import { getRuntimeConfig } from "../config/config.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { SubagentCoordinationDisplayResolver } from "./chat-display-projection.history.js";
import { createBoundSessionHistorySubagentProjection } from "./session-history-readonly-reader.js";
import { prepareGatewaySessionStoreReadSources } from "./session-utils-store-sources.js";

/** Bind host-owned stores and retain their admission for one display operation. */
export function createSessionHistorySubagentProjection(
  scope: SessionTranscriptReadScope,
): SubagentCoordinationDisplayResolver {
  const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
  const currentSource = {
    agentId: databaseOptions.agentId,
    path: resolveOpenClawAgentSqlitePath(databaseOptions),
  };
  const context = captureOpenClawStateWorkerContext();
  const sourceReads = prepareGatewaySessionStoreReadSources({
    cfg: getRuntimeConfig(),
    currentSource,
    env: process.env,
    registryPath: context.admission.databasePath,
  });
  const bound = createBoundSessionHistorySubagentProjection(
    (read) => withCurrentProjectionSnapshot(scope, read, { readOnly: true }),
    {
      path: context.admission.databasePath,
      environment: context.environment,
      coordinatorRuntime: context.coordinatorRuntime,
    },
    sourceReads.sources,
  );
  const assertCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    sourceReads.assertCurrent();
  };
  const readCurrent = <T>(read: () => T): T => {
    assertCurrent();
    const result = read();
    assertCurrent();
    return result;
  };
  return {
    assertCurrent,
    isSubagentSession: (sessionKey) => readCurrent(() => bound.isSubagentSession(sessionKey)),
    isSubagentRunMessage: (runId, messageSeq) =>
      readCurrent(() => bound.isSubagentRunMessage(runId, messageSeq)),
  };
}
