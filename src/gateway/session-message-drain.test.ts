import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { waitForSessionEvent } from "./session-message-event.test-support.js";
import { removeSessionTestDirectories } from "./session-test-directories.test-support.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

vi.mock("../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-sdk/browser-maintenance.js")>()),
  closeTrackedBrowserTabsForSessions: vi.fn().mockResolvedValue(0),
}));

installGatewayTestHooks({ scope: "suite" });

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
const clients: WebSocket[] = [];
const cleanupDirs: string[] = [];

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  for (const subscription of ["messages", "list", "both"]) {
    const ws = await harness.openWs();
    clients.push(ws);
    await connectOk(ws, {
      scopes: ["operator.read", "operator.admin"],
      ...(subscription !== "list" ? { caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS] } : {}),
    });
    if (subscription !== "messages") {
      expect((await rpcReq(ws, "sessions.subscribe")).ok).toBe(true);
    }
  }
});

afterAll(async () => {
  clients.forEach((ws) => ws.close());
  await harness?.close();
});

afterEach(() => removeSessionTestDirectories(cleanupDirs.splice(0)));

test.each(["reset", "new", "delete"])(
  "delivers %s notices to message-only, list-only, and overlapping subscribers",
  async (reason) => {
    const method = reason === "delete" ? "sessions.delete" : "sessions.reset";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-drain-"));
    cleanupDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;
    const sessionKey = `agent:main:drain-${reason}`;
    await writeSessionStore({
      storePath,
      entries: { [sessionKey]: { sessionId: `session-${reason}`, updatedAt: Date.now() } },
    });
    for (const ws of [clients[0]!, clients[2]!]) {
      const response = await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
      expect(response.ok, JSON.stringify(response)).toBe(true);
    }
    const notices = clients.map((ws) => waitForSessionEvent(ws, "socket.drain", { sessionKey }));
    const [response, ...events] = await Promise.all([
      rpcReq(clients[0]!, method, {
        key: sessionKey,
        ...(method === "sessions.reset" ? { reason } : {}),
      }),
      ...notices,
    ]);
    expect(response.ok, JSON.stringify(response)).toBe(true);
    for (const event of events) {
      expect(event.payload).toMatchObject({
        sessionKey,
        agentId: "main",
        reason,
        ts: expect.any(Number),
      });
    }
  },
);
