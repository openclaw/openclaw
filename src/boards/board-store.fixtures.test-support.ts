import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

export async function closeBoardDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

export function boardFixture(stateDir: string, sessionKey = "agent:main:board", agentId = "main") {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawAgentDatabase({ agentId, env });
  replaceSessionEntrySync(
    { agentId, env, sessionKey, storePath: database.path },
    { sessionId: `session-${agentId}-${sessionKey.replaceAll(":", "-")}`, updatedAt: 1 },
  );
  const options = { agentId, path: database.path, env };
  const storeOptions = { resolveSession: () => ({ agentId, sessionKey }), env };
  return {
    env,
    database,
    options,
    storeOptions,
    target: { sessionKey },
    sessionKey,
    store: new SqliteBoardStore(storeOptions),
  };
}

export function htmlWidget(sessionKey: string, name: string, html: string) {
  return { sessionKey, name, content: { kind: "html" as const, html } };
}

export function mcpContent(
  descriptor: Partial<
    Extract<BoardWidgetMaterializedPutParams["content"], { kind: "mcp-app" }>["descriptor"]
  > = {},
  interactive = true,
) {
  return {
    kind: "mcp-app" as const,
    descriptor: {
      serverName: "server",
      toolName: "tool",
      uiResourceUri: "ui://app",
      toolCallId: "call",
      ...descriptor,
    },
    interactive,
  };
}
