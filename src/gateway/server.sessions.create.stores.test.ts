import fs from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  resolveSessionEntryAccessTarget,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
  withFixedOwnerSessionStore,
} from "./server.sessions.create.test-support.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  sessionStoreEntry,
  directSessionReq,
  sessionHookMocks,
  sessionLifecycleHookMocks,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const {
  createSessionStoreDir,
  createSelectedGlobalSessionStore,
  openClient,
  resetConfiguredGlobalAgentSessionStore,
} = setupSessionCreateTestHarness();

type CreatedSessionPayload = { key?: string; sessionId?: string; entry?: SessionEntry };

test("creates a fresh selected-agent child outside fixed global ownership through RPC", () =>
  withFixedOwnerSessionStore(createSessionStoreDir, "global", async ({ storePath }) => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "global", storePath },
      { sessionId: "fixed-global-owner", updatedAt: 1 },
    );
    const { ws } = await openClient();
    try {
      const created = await rpcReq<{ key: string }>(ws, "sessions.create", {
        agentId: "ops",
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const key = requireNonEmptyString(created.payload?.key, "fresh child key");
      expect(key).toMatch(/^agent:ops:dashboard:/);
      expect(loadSessionEntry({ agentId: "ops", sessionKey: key, storePath })).toBeDefined();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "global", storePath })?.sessionId,
      ).toBe("fixed-global-owner");
    } finally {
      await closeGatewayTestWebSocket(ws);
    }
  }));

test("publishes an explicit non-main session before the next socket describe and list", () =>
  withFixedOwnerSessionStore(createSessionStoreDir, "global", async () => {
    const key = "agent:ops:dashboard:publication-owner";
    const { ws } = await openClient();
    try {
      const warm = await rpcReq<SessionsListResult>(ws, "sessions.list", { agentId: "ops" });
      expect(warm.ok, JSON.stringify(warm)).toBe(true);
      const created = await rpcReq<CreatedSessionPayload>(ws, "sessions.create", {
        agentId: "ops",
        key,
        label: "Publication owner",
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const sessionId = requireNonEmptyString(created.payload?.sessionId, "created session id");
      expect(created.payload?.key).toBe(key);
      const expected = { key, sessionId, label: "Publication owner" };
      const described = await rpcReq<{ session: GatewaySessionRow | null }>(
        ws,
        "sessions.describe",
        { agentId: "ops", key },
      );
      expect(described.ok, JSON.stringify(described)).toBe(true);
      expect(described.payload?.session).toMatchObject(expected);
      const listed = await rpcReq<SessionsListResult>(ws, "sessions.list", {
        agentId: "ops",
        limit: 100,
      });
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      expect(listed.payload?.sessions.find((row) => row.key === key)).toMatchObject(expected);
    } finally {
      await closeGatewayTestWebSocket(ws);
    }
  }));

test("publishes an explicit non-main session through a junction-backed store", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: {}, storePath });
  const alias = `${dir}-alias`;
  await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
  testState.sessionStorePath = path.join(alias, path.basename(storePath));
  const config = await getGatewayConfigModule();
  config.clearRuntimeConfigSnapshot();
  config.clearConfigCache();
  const key = "agent:main:dashboard:junction-publication";
  const { ws } = await openClient();
  try {
    const created = await rpcReq<CreatedSessionPayload>(ws, "sessions.create", {
      agentId: "main",
      key,
      label: "Junction publication",
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "created session id");
    expect(created.payload?.key).toBe(key);
    const described = await rpcReq<{ session: GatewaySessionRow | null }>(ws, "sessions.describe", {
      agentId: "main",
      key,
    });
    expect(described.ok, JSON.stringify(described)).toBe(true);
    expect(described.payload?.session).toMatchObject({
      key,
      sessionId,
      label: "Junction publication",
    });
  } finally {
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.create scopes the main alias to the requested agent", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "longmemeval" }] };
  testState.agentConfig = { sessionStore: { agentId: "longmemeval" } };

  const created = await directSessionReq<CreatedSessionPayload>("sessions.create", {
    key: "main",
    agentId: "longmemeval",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toBe("agent:longmemeval:main");
  expect(created.payload?.entry).not.toHaveProperty("sessionFile");

  expect(
    loadSessionEntry({
      agentId: "longmemeval",
      sessionKey: "agent:longmemeval:main",
      storePath,
    })?.sessionId,
  ).toBe(created.payload?.sessionId);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
  ).toBeUndefined();
});

test("sessions.create replaces a dead main entry with a fresh session id", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  try {
    await writeSessionStore({
      agentId: "ops",
      entries: {
        main: {
          updatedAt: 1,
          label: "Ops Main",
          sessionFile: "stale.jsonl",
        },
      },
    });

    const created = await directSessionReq<CreatedSessionPayload>("sessions.create", {
      key: "main",
      agentId: "ops",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe("agent:ops:main");
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.payload?.entry?.label).toBeUndefined();
    expect(created.payload?.entry?.sessionFile).not.toBe("stale.jsonl");

    const storedEntry = loadSessionEntry({
      agentId: "ops",
      sessionKey: "agent:ops:main",
      storePath,
    });
    expect(storedEntry?.sessionId).toBe(created.payload?.sessionId);
    expect(storedEntry?.sessionFile).not.toBe("stale.jsonl");
  } finally {
    testState.agentsConfig = undefined;
  }
});

test("sessions.create preserves global and unknown sentinel keys", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "longmemeval" }] };
  testState.agentConfig = { sessionStore: { agentId: "longmemeval" } };

  const sessionIds = new Map<string, string | undefined>();
  for (const key of ["global", "unknown"]) {
    const created = await directSessionReq<CreatedSessionPayload>("sessions.create", {
      key,
      agentId: "longmemeval",
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.key).toBe(key);
    expect(created.payload?.entry).not.toHaveProperty("sessionFile");
    sessionIds.set(key, created.payload?.sessionId);
  }
  for (const [key, sessionId] of sessionIds) {
    expect(
      loadSessionEntry({ agentId: "longmemeval", sessionKey: key, storePath })?.sessionId,
    ).toBe(sessionId);
    expect(
      loadSessionEntry({
        agentId: "longmemeval",
        sessionKey: `agent:longmemeval:${key}`,
        storePath,
      }),
    ).toBeUndefined();
  }
});

test("sessions.create applies configured fixed-store ownership to bare keys", async () => {
  const { storePath } = await createSessionStoreDir();
  const broadcastToConnIds = vi.fn();
  testState.agentsConfig = {
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  };
  testState.agentConfig = { sessionStore: { agentId: "ops" } };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  try {
    const created = await directSessionReq<{ key?: string; sessionId?: string }>(
      "sessions.create",
      { key: "global" },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );

    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.payload?.key).toBe("global");
    expect(loadSessionEntry({ agentId: "ops", sessionKey: "global", storePath })?.sessionId).toBe(
      created.payload?.sessionId,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", agentId: "ops", reason: "create" }),
      new Set(["conn-1"]),
      {
        dropIfSlow: true,
        agentId: "ops",
        sessionKeys: ["global"],
        prepareSessionProjection: expect.any(Function),
      },
    );

    const conflict = await directSessionReq("sessions.create", {
      key: "global",
      agentId: "research",
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'agent "research" does not match session key agent "ops"',
      },
    });
  } finally {
    testState.agentsConfig = undefined;
    testState.agentConfig = {};
  }
});

test("sessions.create loads selected global parent from the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-parent", {
          providerOverride: "codex",
          modelOverride: "main-model",
        }),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-parent", {
          providerOverride: "openai",
          modelOverride: "work-model",
          thinkingLevel: "high",
        }),
      },
    });

    const created = await directSessionReq<CreatedSessionPayload>("sessions.create", {
      agentId: "work",
      parentSessionKey: "global",
      emitCommandHooks: true,
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:work:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("global");
    expect(created.payload?.entry?.providerOverride).toBe("openai");
    expect(created.payload?.entry?.modelOverride).toBe("work-model");
    expect(created.payload?.entry?.thinkingLevel).toBe("high");

    const commandNewEvent = sessionHookMocks.triggerInternalHook.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event !== null &&
          typeof event === "object" &&
          "type" in event &&
          event.type === "command" &&
          "action" in event &&
          event.action === "new",
      );
    expect(commandNewEvent).toMatchObject({
      context: { sessionEntry: { sessionId: "sess-work-parent" } },
    });
    expect(sessionLifecycleHookMocks.runSessionEnd.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-work-parent",
      sessionKey: "global",
    });
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.get reads selected global messages from the requested agent store", async () => {
  const { mainStorePath, storeTemplate, workStorePath } = await createSelectedGlobalSessionStore();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-global"),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global"),
      },
    });
    await seedSessionTranscript({
      agentId: "main",
      messages: [{ role: "user", content: "main global" }],
      sessionId: "sess-main-global",
      sessionKey: "global",
      storePath: mainStorePath,
    });
    await seedSessionTranscript({
      agentId: "work",
      messages: [{ role: "user", content: "work global" }],
      sessionId: "sess-work-global",
      sessionKey: "global",
      storePath: workStorePath,
    });

    const cfg = {
      agents: { entries: { main: {}, work: {} } },
      session: { scope: "global", store: storeTemplate },
    };
    const result = await directSessionReq<{ messages?: unknown[] }>(
      "sessions.get",
      {
        key: "global",
        agentId: "work",
      },
      {
        context: {
          getRuntimeConfig: () => cfg,
        },
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const renderedMessages = JSON.stringify(result.payload?.messages ?? []);
    expect(renderedMessages).toContain("work global");
    expect(renderedMessages).not.toContain("main global");
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create checks selected global initialization in the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const broadcastToConnIds = vi.fn();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-initializing", { initializationPending: true }),
      },
    });

    const created = await directSessionReq<CreatedSessionPayload>(
      "sessions.create",
      { key: "global", agentId: "work" },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );

    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.payload).toMatchObject({ key: "global" });
    expect(created.payload?.entry).not.toHaveProperty("sessionFile");
    expect(
      loadSessionEntry({ agentId: "work", sessionKey: "global", storePath: workStorePath }),
    ).toMatchObject({ sessionId: created.payload?.sessionId });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath }),
    ).toMatchObject({ sessionId: "sess-main-initializing", initializationPending: true });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", agentId: "work", reason: "create" }),
      new Set(["conn-1"]),
      {
        dropIfSlow: true,
        agentId: "work",
        sessionKeys: ["global"],
        prepareSessionProjection: expect.any(Function),
      },
    );

    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-initializing", { initializationPending: true }),
      },
    });
    expect(
      resolveSessionEntryAccessTarget({
        cfg: getRuntimeConfig(),
        sessionKey: "global",
        agentId: "work",
      }).entry,
    ).toMatchObject({ sessionId: "sess-work-initializing", initializationPending: true });
    const blocked = await directSessionReq("sessions.create", { key: "global", agentId: "work" });
    expect(blocked).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Session global is still initializing; retry creation later.",
      },
    });
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create sends selected global initial tasks to the requested agent", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  onTestFinished(async () =>
    resetConfiguredGlobalAgentSessionStore({
      ...(await getGatewayConfigModule()),
      configPath: requireNonEmptyString(process.env.OPENCLAW_CONFIG_PATH, "config path"),
    }),
  );
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    runStarted?: boolean;
    runId?: string;
  }>(ws, "sessions.create", {
    key: "global",
    agentId: "work",
    task: "hello selected global",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("global");
  expect(created.payload?.runStarted).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "selected global run id");
  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  const workEntry = loadSessionEntry({
    agentId: "work",
    sessionKey: "global",
    storePath: workStorePath,
  });
  const workSessionId = requireNonEmptyString(workEntry?.sessionId, "selected global session id");
  await expect(
    loadTranscriptEvents({
      agentId: "work",
      sessionId: workSessionId,
      sessionKey: "global",
      storePath: workStorePath,
    }),
  ).resolves.toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({ content: "hello selected global" }),
      type: "message",
    }),
  );
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath }),
  ).toBeUndefined();
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
  ws.close();
});
