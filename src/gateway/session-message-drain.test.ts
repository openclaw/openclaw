import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { removeSessionTestDirectories } from "./session-test-directories.test-support.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

vi.mock("../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-sdk/browser-maintenance.js")>()),
  closeTrackedBrowserTabsForSessions: vi.fn().mockResolvedValue(0),
}));

installGatewayTestHooks({ scope: "suite" });

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let clients: WebSocket[];
const cleanupDirs: string[] = [];

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  clients = [];
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
  for (const ws of clients ?? []) {
    ws.close();
  }
  await harness?.close();
});

afterEach(async () => {
  await removeSessionTestDirectories(cleanupDirs.splice(0));
});

test.each([
  { reason: "reset", method: "sessions.reset" },
  { reason: "new", method: "sessions.reset" },
  { reason: "delete", method: "sessions.delete" },
])(
  "delivers $reason notices to message-only, list-only, and overlapping subscribers",
  async ({ reason, method }) => {
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
    const notices = clients.map((ws) =>
      onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "socket.drain" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
      ),
    );
    const [, ...events] = await Promise.all([
      rpcReq(clients[0]!, method, {
        key: sessionKey,
        ...(method === "sessions.reset" ? { reason } : {}),
      }).then((response) => {
        expect(response.ok, JSON.stringify(response)).toBe(true);
      }),
      ...notices,
    ]);
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
