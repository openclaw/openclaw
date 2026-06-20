import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  installGatewayTestHooks,
  piSdkMock,
  testState,
  writeSessionStore,
} from "../test-helpers.js";

installGatewayTestHooks();

type HandlerResult = { ok: boolean; payload?: unknown; error?: unknown };

async function callSessionHandler(method: string, params: Record<string, unknown>) {
  const [{ sessionsHandlers }, { getRuntimeConfig }] = await Promise.all([
    import("./sessions.js"),
    import("../../config/config.js"),
  ]);
  let result: HandlerResult | undefined;
  const handler = sessionsHandlers[method as keyof typeof sessionsHandlers];
  await handler({
    req: { type: "req", id: method, method, params },
    params,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: {
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      loadGatewayModelCatalog: async () => piSdkMock.models,
      getRuntimeConfig,
      logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  if (!result) {
    throw new Error(`${method} did not respond`);
  }
  return result;
}

test("sessions.get and sessions.describe read through async JSON store wrappers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-handler-"));
  try {
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      `${JSON.stringify({ message: { role: "user", content: "hello async store" } })}\n`,
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const get = await callSessionHandler("sessions.get", { key: "main" });
    expect(get.ok).toBe(true);
    expect((get.payload as { messages?: unknown[] } | undefined)?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user" })]),
    );

    const describe = await callSessionHandler("sessions.describe", { key: "main" });
    expect(describe.ok).toBe(true);
    expect(
      (describe.payload as { session?: { key?: string; sessionId?: string } } | undefined)?.session,
    ).toMatchObject({ key: "agent:main:main", sessionId: "sess-main" });
  } finally {
    testState.sessionStorePath = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions.list uses the bounded async store window for simple list reads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-list-handler-"));
  try {
    testState.sessionStorePath = path.join(dir, "sessions.json");
    const now = Date.now();
    await writeSessionStore({
      entries: {
        global: { sessionId: "sess-global", updatedAt: now },
        newer: { sessionId: "sess-newer", updatedAt: now - 1_000, label: "focus" },
        middle: { sessionId: "sess-middle", updatedAt: now - 2_000, label: "focus" },
        older: { sessionId: "sess-older", updatedAt: now - 3_600_000, label: "backlog" },
        unknown: { sessionId: "sess-unknown", updatedAt: now },
      },
    });

    const list = await callSessionHandler("sessions.list", {
      limit: 2,
      label: "focus",
      activeMinutes: 5,
    });
    expect(list.ok).toBe(true);
    expect(
      (list.payload as { totalCount?: number; count?: number; sessions?: Array<{ key: string }> })
        .totalCount,
    ).toBe(2);
    expect(
      (
        list.payload as { totalCount?: number; count?: number; sessions?: Array<{ key: string }> }
      ).sessions?.map((session) => session.key),
    ).toEqual(["agent:main:newer", "agent:main:middle"]);
  } finally {
    testState.sessionStorePath = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
