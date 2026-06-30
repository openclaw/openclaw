import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { agentCommand, rpcReq, testState } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function configurePerAgentSessionStore(dir: string) {
  const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
  testState.sessionStorePath = storeTemplate;
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  return storeTemplate;
}

function resetSessionStoreFixture() {
  testState.agentsConfig = undefined;
  testState.sessionStorePath = undefined;
}

test("agent RPC rejects deleted-agent session keys before dispatch", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = await configurePerAgentSessionStore(dir);
  const deletedStorePath = storeTemplate.replace("{agentId}", "deleted-agent");
  const orphanKey = "agent:deleted-agent:main";

  await fs.mkdir(path.dirname(deletedStorePath), { recursive: true });
  await fs.writeFile(
    deletedStorePath,
    JSON.stringify(
      {
        [orphanKey]: sessionStoreEntry("sess-orphan"),
      },
      null,
      2,
    ),
    "utf-8",
  );

  vi.mocked(agentCommand).mockClear();
  const { ws } = await openClient();
  try {
    const blocked = await rpcReq(ws, "agent", {
      sessionKey: orphanKey,
      message: "hi",
      idempotencyKey: "proof-deleted-agent",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
    expect(agentCommand).not.toHaveBeenCalled();
  } finally {
    ws.close();
    resetSessionStoreFixture();
  }
});

test("agent RPC still dispatches for configured-agent session keys", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = await configurePerAgentSessionStore(dir);
  const mainStorePath = storeTemplate.replace("{agentId}", "main");

  await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
  await fs.writeFile(
    mainStorePath,
    JSON.stringify(
      {
        main: sessionStoreEntry("sess-main"),
      },
      null,
      2,
    ),
    "utf-8",
  );

  vi.mocked(agentCommand).mockClear();
  const { ws } = await openClient();
  try {
    const accepted = await rpcReq(ws, "agent", {
      sessionKey: "main",
      message: "ping",
      idempotencyKey: "proof-main-agent",
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.payload?.status).toBe("accepted");
    expect(accepted.payload?.runId).toBe("proof-main-agent");
    await vi.waitFor(() => expect(agentCommand).toHaveBeenCalled());
  } finally {
    ws.close();
    resetSessionStoreFixture();
  }
});
