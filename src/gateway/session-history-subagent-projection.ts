import { getRuntimeConfig } from "../config/config.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type {
  SessionEntryReadSource,
  SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.types.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { SubagentCoordinationDisplayResolver } from "./chat-display-projection.history.js";
import { createBoundSessionHistorySubagentProjection } from "./session-history-readonly-reader.js";
import { prepareGatewaySessionStoreReadSources } from "./session-utils-store-sources.js";

/** Bind source addresses and admission once, before an asynchronous history read. */
function prepareSessionHistorySubagentSources(
  currentSource: SessionEntryReadSource,
  options: { env?: NodeJS.ProcessEnv; deferSources?: boolean } = {},
) {
  const env = options.env ?? process.env;
  const context = captureOpenClawStateWorkerContext({ env });
  const sourceReads = prepareGatewaySessionStoreReadSources({
    cfg: getRuntimeConfig(),
    currentSource,
    env,
    registryPath: context.admission.databasePath,
    deferSources: options.deferSources,
  });
  return {
    stateDatabase: {
      path: context.admission.databasePath,
      environment: context.environment,
      coordinatorRuntime: context.coordinatorRuntime,
    },
    get sourceDatabases() {
      return sourceReads.sources;
    },
    assertCurrent: () => {
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      sourceReads.assertCurrent();
    },
  };
}

/** Bind host-owned stores and retain their admission for one display operation. */
export function createSessionHistorySubagentProjection(
  scope: SessionTranscriptReadScope,
  options: { deferSources?: boolean } = {},
): SubagentCoordinationDisplayResolver {
  const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
  const sources = prepareSessionHistorySubagentSources(
    { agentId: databaseOptions.agentId, path: resolveOpenClawAgentSqlitePath(databaseOptions) },
    options,
  );
  const bound = createBoundSessionHistorySubagentProjection(
    (read) => withCurrentProjectionSnapshot(scope, read, { readOnly: true }),
    sources.stateDatabase,
    () => sources.sourceDatabases,
  );
  const assertCurrent = sources.assertCurrent;
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
