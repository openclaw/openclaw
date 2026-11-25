import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import type { BoardStore, BoardSessionTarget } from "./board-store.js";
import { createTestBoardStore } from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

export function testBoard(sessionKey = "agent:main:board") {
  return boardClient(createTestBoardStore(), { sessionKey });
}

function boardClient(store: BoardStore, target: BoardSessionTarget) {
  return {
    store,
    snapshot: () => store.getSnapshot(target),
    document: (name: string) => store.useWidgetDocument(target, name, (value) => value),
    app: () => store.readWidgetMcpApp(target, "app"),
    ops: (...ops: Parameters<BoardStore["applyOps"]>[1]) => store.applyOps(target, ops),
    put: (params: Omit<BoardWidgetMaterializedPutParams, "sessionKey">) =>
      store.putWidget({ ...target, ...params }),
    grant: (
      name: string,
      revision: number,
      instanceId?: string,
      decision: "granted" | "rejected" = "granted",
    ) => store.grant(target, name, decision, revision, instanceId),
  };
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
    ...boardClient(new SqliteBoardStore(storeOptions), { sessionKey }),
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
