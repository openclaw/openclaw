import path from "node:path";
import { expect, test, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { agentCommandMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function configurePerAgentSessionStore(dir: string) {
  const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
  testState.sessionStorePath = storeTemplate;
  testState.agentsConfig = { entries: { main: {} } };
  return storeTemplate;
}

function resetSessionStoreFixture() {
  testState.agentsConfig = undefined;
  testState.sessionStorePath = undefined;
}

test("agent RPC rejects archived session keys before dispatch", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = await configurePerAgentSessionStore(dir);
  const mainStorePath = storeTemplate.replace("{agentId}", "main");
  const archivedKey = "agent:main:subagent:archived";

  await writeSessionStore({
    storePath: mainStorePath,
    agentId: "main",
    entries: {
      [archivedKey]: sessionStoreEntry("sess-archived", { archivedAt: Date.now() }),
    },
  });

  vi.mocked(agentCommandMock).mockClear();
  const { ws } = await openClient();
  try {
    const blocked = await rpcReq(ws, "agent", {
      sessionKey: archivedKey,
      message: "hi",
      idempotencyKey: "proof-archived-session",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message:
        'Session "agent:main:subagent:archived" is archived. Restore it before starting new work.',
    });
    expect(agentCommandMock).not.toHaveBeenCalled();
  } finally {
    ws.close();
    resetSessionStoreFixture();
  }
});
