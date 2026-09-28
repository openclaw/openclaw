import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { rpcReq, testState } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { openClient } = setupGatewaySessionsTestHarness();

test("tools.effective rejects a mismatched configured agent for a non-global session key", async () => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!configPath || !stateDir) {
    throw new Error("OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR are required");
  }
  const dir = path.join(stateDir, "session-stores", `tools-effective-nonglobal-${Date.now()}`);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  testState.sessionConfig = undefined;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { store: storePath },
    }),
    "utf-8",
  );
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await replaceSessionEntry(
    { storePath, sessionKey: "agent:main:abc" },
    { sessionId: "sess-main-agent", updatedAt: 1 },
  );
  const { ws } = await openClient();
  try {
    const res = await rpcReq(ws, "tools.effective", {
      sessionKey: "agent:main:abc",
      agentId: "work",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'agent "work" does not match session key agent "main"',
    });
  } finally {
    ws.close();
    testState.sessionStorePath = undefined;
    await fs.writeFile(configPath, "{}\n", "utf-8");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  }
});
