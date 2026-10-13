import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
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

vi.mock("../plugin-sdk/browser-maintenance.js", async () => {
  const actual = await vi.importActual<typeof import("../plugin-sdk/browser-maintenance.js")>(
    "../plugin-sdk/browser-maintenance.js",
  );
  return {
    ...actual,
    closeTrackedBrowserTabsForSessions: vi.fn().mockResolvedValue(0),
  };
});

installGatewayTestHooks({ scope: "suite" });

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
const cleanupDirs: string[] = [];

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness?.close();
});

afterEach(async () => {
  await removeSessionTestDirectories(cleanupDirs.splice(0));
});

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-drain-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

async function withAdminSessionSubscriber<T>(run: (ws: WebSocket) => Promise<T>) {
  const ws = await harness.openWs();
  try {
    await connectOk(ws, { scopes: ["operator.read", "operator.admin"] });
    await rpcReq(ws, "sessions.subscribe");
    return await run(ws);
  } finally {
    ws.close();
  }
}

test("broadcasts socket.drain event when a session is reset for message subscribers", async () => {
  vi.useRealTimers();
  const storePath = await createSessionStoreFile();
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-msg-subs-1",
        updatedAt: Date.now(),
      },
    },
    storePath,
  });

  const ws = await harness.openWs();
  try {
    await connectOk(ws, { scopes: ["operator.read", "operator.admin"] });
    const subRes = await rpcReq(ws, "sessions.messages.subscribe", { key: "agent:main:main" });
    expect(subRes.ok, JSON.stringify(subRes)).toBe(true);
    expect(subRes.payload).toMatchObject({
      subscribed: true,
      key: "agent:main:main",
    });

    const socketDrainPromise = onceMessage(
      ws,
      (message) =>
        message.type === "event" &&
        message.event === "socket.drain" &&
        (message.payload as { sessionKey?: string } | undefined)?.sessionKey === "agent:main:main",
      5000,
    );

    const resetRes = await rpcReq(ws, "sessions.reset", { key: "agent:main:main" });
    expect(resetRes.ok, JSON.stringify(resetRes)).toBe(true);

    const drainEvent = await socketDrainPromise;
    expect(drainEvent.payload).toMatchObject({
      sessionKey: "agent:main:main",
      reason: "reset",
    });
    expect(typeof (drainEvent.payload as { ts?: unknown }).ts).toBe("number");
  } finally {
    ws.close();
  }
});

test("broadcasts socket.drain event when a session is reset", async () => {
  vi.useRealTimers();
  const storePath = await createSessionStoreFile();
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-reset-1",
        updatedAt: Date.now(),
      },
    },
    storePath,
  });

  await withAdminSessionSubscriber(async (ws) => {
    const socketDrainPromise = onceMessage(
      ws,
      (message) =>
        message.type === "event" &&
        message.event === "socket.drain" &&
        (message.payload as { sessionKey?: string } | undefined)?.sessionKey === "agent:main:main",
      5000,
    );

    const resetRes = await rpcReq(ws, "sessions.reset", { key: "agent:main:main" });
    expect(resetRes.ok, JSON.stringify(resetRes)).toBe(true);

    const drainEvent = await socketDrainPromise;
    expect(drainEvent.payload).toMatchObject({
      sessionKey: "agent:main:main",
      reason: "reset",
    });
    expect(typeof (drainEvent.payload as { ts?: unknown }).ts).toBe("number");
  });
});

test("broadcasts socket.drain event when a session is reset with reason 'new'", async () => {
  vi.useRealTimers();
  const storePath = await createSessionStoreFile();
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-reset-2",
        updatedAt: Date.now(),
      },
    },
    storePath,
  });

  await withAdminSessionSubscriber(async (ws) => {
    const socketDrainPromise = onceMessage(
      ws,
      (message) =>
        message.type === "event" &&
        message.event === "socket.drain" &&
        (message.payload as { sessionKey?: string } | undefined)?.sessionKey === "agent:main:main",
      5000,
    );

    const resetRes = await rpcReq(ws, "sessions.reset", {
      key: "agent:main:main",
      reason: "new",
    });
    expect(resetRes.ok, JSON.stringify(resetRes)).toBe(true);

    const drainEvent = await socketDrainPromise;
    expect(drainEvent.payload).toMatchObject({
      sessionKey: "agent:main:main",
      reason: "new",
    });
    expect(typeof (drainEvent.payload as { ts?: unknown }).ts).toBe("number");
  });
});

test("broadcasts socket.drain event when a session is deleted", async () => {
  vi.useRealTimers();
  const storePath = await createSessionStoreFile();
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-deleted-main",
        updatedAt: Date.now(),
      },
      worker: {
        sessionId: "sess-deleted-worker",
        updatedAt: Date.now(),
      },
    },
    storePath,
  });

  await withAdminSessionSubscriber(async (ws) => {
    const socketDrainPromise = onceMessage(
      ws,
      (message) =>
        message.type === "event" &&
        message.event === "socket.drain" &&
        (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
          "agent:main:worker",
      5000,
    );

    const deleteRes = await rpcReq(ws, "sessions.delete", { key: "agent:main:worker" });
    expect(deleteRes.ok).toBe(true);

    const drainEvent = await socketDrainPromise;
    expect(drainEvent.payload).toMatchObject({
      sessionKey: "agent:main:worker",
      reason: "delete",
    });
    expect(typeof (drainEvent.payload as { ts?: unknown }).ts).toBe("number");
  });
});
