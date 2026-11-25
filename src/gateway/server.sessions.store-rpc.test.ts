import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
/**
 * Gateway session store RPC tests.
 */
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { CronJob } from "../cron/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { createChatRunState } from "./server-chat-state.js";
import {
  loadTranscriptRows,
  seedLinearTranscript,
} from "./server.sessions.store-rpc.test-helpers.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { agentDiscoveryMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq as directSessionHandlerReq,
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();

test("preserves session privacy, archive refusal, and reset delivery through RPC", async () => {
  const { storePath } = await createSessionStoreDir();
  const now = Date.now();
  const recent = now - 30_000;
  const stale = now - 15 * 60_000;

  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: recent,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 10,
        outputTokens: 20,
        thinkingLevel: "low",
        verboseLevel: "on",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "work",
        lastThreadId: "1737500000.123456",
      },
      "discord:group:dev": {
        sessionId: "sess-group",
        updatedAt: stale,
        totalTokens: 50,
        origin: { label: "U123ABC45" },
      },
      "agent:main:subagent:one": {
        sessionId: "sess-subagent",
        updatedAt: stale,
        spawnedBy: "agent:main:main",
      },
      "agent:main:telegram:main:direct:491234567890": {
        sessionId: "sess-direct",
        updatedAt: stale,
      },
      global: {
        sessionId: "sess-global",
        updatedAt: now - 10_000,
      },
    },
  });
  await seedLinearTranscript({
    contents: ["original main transcript"],
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const directContext = {
    chatRunState: createChatRunState(),
    broadcastToConnIds: vi.fn(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { debug: vi.fn() },
    loadGatewayModelCatalog: async () => agentDiscoveryMock.models,
    loadGatewayModelCatalogSnapshot: async () => ({
      entries: agentDiscoveryMock.models,
      routeVariants: agentDiscoveryMock.models,
    }),
    getRuntimeConfig,
  };
  const directSessionReq = <TPayload = unknown>(
    method: Parameters<typeof directSessionHandlerReq>[0],
    params: Record<string, unknown>,
  ) => directSessionHandlerReq<TPayload>(method, params, { context: directContext });

  const list1 = await directSessionReq<SessionsListResult>("sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
  });

  expect(list1.ok).toBe(true);
  expect(list1.payload?.sessions.map((session) => session.key)).not.toContain("global");
  const group = list1.payload?.sessions.find((s) => s.key === "agent:main:discord:group:dev");
  expect(group).toMatchObject({ classification: "group", peerKind: "group" });
  expect(
    JSON.stringify({
      classification: group?.classification,
      agentId: group?.agentId,
      accountId: group?.accountId,
      peerKind: group?.peerKind,
      isMain: group?.isMain,
      isBackground: group?.isBackground,
    }),
  ).not.toContain("U123ABC45");
  const direct = list1.payload?.sessions.find(
    (s) => s.key === "agent:main:telegram:main:direct:491234567890",
  );
  expect(direct).toMatchObject({
    classification: "direct",
    accountId: "main",
    peerKind: "direct",
  });
  expect(
    JSON.stringify({
      classification: direct?.classification,
      agentId: direct?.agentId,
      accountId: direct?.accountId,
      peerKind: direct?.peerKind,
      isMain: direct?.isMain,
      isBackground: direct?.isBackground,
    }),
  ).not.toContain("491234567890");

  const mainArchive = await directSessionReq("sessions.patch", {
    key: "agent:main:main",
    archived: true,
  });
  expect(mainArchive.ok).toBe(false);

  const archived = await directSessionReq<{
    entry: { archivedAt?: number; pinnedAt?: number };
  }>("sessions.patch", {
    key: "agent:main:discord:group:dev",
    archived: true,
    expectedSessionId: "sess-group",
  });
  expect(archived.ok).toBe(true);
  expect(archived.payload?.entry.archivedAt).toEqual(expect.any(Number));
  expect(archived.payload?.entry.pinnedAt).toBeUndefined();

  const archivedSend = await directSessionReq("sessions.send", {
    key: "agent:main:discord:group:dev",
    message: "blocked while archived",
  });
  expect(archivedSend).toMatchObject({
    ok: false,
    error: {
      message:
        'Session "agent:main:discord:group:dev" is archived. Restore it before starting new work.',
    },
  });

  const cachedArchivedRunId = "cached-before-archive";
  directContext.dedupe.set(`chat:${cachedArchivedRunId}`, {
    ts: Date.now(),
    ok: true,
    payload: { runId: cachedArchivedRunId, status: "ok" },
  });
  const cachedArchivedSend = await directSessionReq("sessions.send", {
    key: "agent:main:discord:group:dev",
    message: "already completed before archive",
    idempotencyKey: cachedArchivedRunId,
  });
  expect(cachedArchivedSend).toMatchObject({
    ok: true,
    payload: { runId: cachedArchivedRunId, status: "ok" },
  });

  const archivedReset = await directSessionReq("sessions.reset", {
    key: "agent:main:discord:group:dev",
  });
  expect(archivedReset).toMatchObject({
    ok: false,
    error: {
      message:
        'Session "agent:main:discord:group:dev" is archived. Restore it before starting new work.',
    },
  });

  const restored = await directSessionReq<{
    entry: { archivedAt?: number };
  }>("sessions.patch", {
    key: "agent:main:discord:group:dev",
    archived: false,
    expectedSessionId: "sess-group",
  });
  expect(restored.ok).toBe(true);
  expect(restored.payload?.entry.archivedAt).toBeUndefined();

  for (const [field, value] of Object.entries({
    spawnedBy: "agent:main:main",
    spawnedWorkspaceDir: "/tmp/subagent-workspace",
    spawnedCwd: "/tmp/task-repo",
    spawnDepth: 1,
    subagentRole: "leaf",
    subagentControlScope: "none",
  })) {
    const rejected = await directSessionReq("sessions.patch", {
      key: "agent:main:subagent:two",
      [field]: value,
    });
    expect(rejected.ok, field).toBe(false);
    expect(rejected.error, field).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining(`unexpected property '${field}'`),
    });
  }

  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  const modelPatched = await directSessionReq<{
    ok: true;
    entry: {
      modelOverride?: string;
      providerOverride?: string;
      model?: string;
      modelProvider?: string;
    };
    resolved?: {
      model?: string;
      modelProvider?: string;
      agentRuntime?: { id: string; source: string; devicePlacementSupported?: boolean };
    };
  }>("sessions.patch", {
    key: "agent:main:main",
    model: "openai/gpt-test-a",
  });
  expect(modelPatched.ok).toBe(true);
  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      modelProvider?: string;
      model?: string;
      delivery?: import("../config/sessions/types.js").SessionDeliveryState;
    };
  }>("sessions.reset", { key: "agent:main:main" });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).toBe("sess-main");
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");
  expect(deliveryContextFromSession(reset.payload?.entry)?.accountId).toBe("work");
  expect(deliveryContextFromSession(reset.payload?.entry)?.threadId).toBe("1737500000.123456");
  const entryAfterReset = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(deliveryContextFromSession(entryAfterReset)?.accountId).toBe("work");
  expect(deliveryContextFromSession(entryAfterReset)?.threadId).toBe("1737500000.123456");
  const resetTranscript = await loadTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  expect(resetTranscript.at(-1)).toMatchObject({ type: "reset", reason: "reset" });
  expect(resetTranscript.at(-1)).not.toHaveProperty("firstKeptEntryId");
});

test("sessions.list configuredAgentsOnly keeps configured-agent children and hides unrelated stores", async () => {
  const rootStateDir = expectDefined(process.env.OPENCLAW_STATE_DIR, "OPENCLAW_STATE_DIR");
  const stateDir = path.join(rootStateDir, "configured-list-regression");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    testState.agentsConfig = { ownership: "explicit", entries: { ops: {} } };
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    const configPath = expectDefined(process.env.OPENCLAW_CONFIG_PATH, "OPENCLAW_CONFIG_PATH");
    const configJson = '{"acp":{"defaultAgent":"claude","allowedAgents":["gemini"]}}';
    await fs.writeFile(configPath, configJson, "utf-8");
    const agentsDir = path.join(stateDir, "agents");
    const storeTemplate = path.join(agentsDir, "{agentId}", "sessions", "sessions.json");
    testState.sessionConfig = { store: storeTemplate };

    const acpStorePath = path.join(agentsDir, "claude", "sessions", "sessions.json");
    const childStorePath = path.join(agentsDir, "codex", "sessions", "sessions.json");
    const diskOnlyStorePath = path.join(agentsDir, "local", "sessions", "sessions.json");
    const mainKey = "agent:ops:main";
    const acpKey = "agent:claude:acp:25f77580-de30-4d80-9bc3-7cbc6374bce7";
    const acp = {
      backend: "acpx",
      agent: "claude",
      runtimeSessionName: acpKey,
      mode: "oneshot",
      state: "idle",
      lastActivityAt: 30,
    } as const;
    const spawnedChildKey = "agent:codex:subagent:app-server-child";
    const parentChildKey = "agent:codex:subagent:parent-key-child";
    await writeSessionStore({
      storePath: path.join(agentsDir, "ops", "sessions", "sessions.json"),
      agentId: "ops",
      entries: { main: { sessionId: "sess-main", updatedAt: 20 } },
    });
    await writeSessionStore({
      storePath: acpStorePath,
      agentId: "claude",
      entries: {
        [acpKey]: { sessionId: "sess-claude-acp", updatedAt: 30, acp },
      },
    });
    await writeSessionStore({
      storePath: childStorePath,
      agentId: "codex",
      entries: {
        [spawnedChildKey]: { sessionId: "sess-codex-child", updatedAt: 25, spawnedBy: mainKey },
        [parentChildKey]: { sessionId: "child-2", updatedAt: 27, parentSessionKey: mainKey },
      },
    });
    await writeSessionStore({
      storePath: diskOnlyStorePath,
      agentId: "local",
      entries: { main: { sessionId: "sess-local", updatedAt: 10 } },
    });
    // Physical stores hydrate once before either warm selection policy runs.
    await directSessionHandlerReq("sessions.list", { includeGlobal: false, includeUnknown: false });
    const configuredOnly = await directSessionHandlerReq<SessionsListResult>("sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
    expect(configuredOnly.ok).toBe(true);
    expect(configuredOnly.payload?.sessions.map((session) => session.key)).toEqual([
      acpKey,
      parentChildKey,
      spawnedChildKey,
      mainKey,
    ]);

    const broad = await directSessionHandlerReq<SessionsListResult>("sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
    });
    expect(broad.ok).toBe(true);
    expect(broad.payload?.sessions.map((session) => session.key)).toEqual([
      acpKey,
      parentChildKey,
      spawnedChildKey,
      mainKey,
      "agent:local:main",
    ]);
  });
});

test("write-scoped operators manage chat organization but not admin session settings", async () => {
  const { storePath } = await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: now },
      "topic-a": {
        sessionId: "sess-topic-a",
        updatedAt: now - 60_000,
        // Stored channel-derived name; a user rename (label) must beat it.
        displayName: "channel topic",
      },
      "topic-b": { sessionId: "sess-topic-b", updatedAt: now - 30_000 },
    },
  });

  const { getRuntimeConfig, writeConfigFile } = await getGatewayConfigModule();
  // Catalog workers need the fixture model in configuration, not a host-only discovery mock.
  await writeConfigFile({
    ...getRuntimeConfig(),
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://openai.invalid/v1",
          agentRuntime: { id: "openclaw" },
          models: [
            modelDefinition("gpt-test-a", {
              name: "A",
              reasoning: false,
              contextWindow: 32768,
              maxTokens: 2048,
            }),
          ],
        },
      },
    },
  });

  const { ws } = await openClient({ scopes: ["operator.write"] });
  try {
    const renamed = await rpcReq<{
      ok: true;
      entry: { label?: string; modelOverride?: string; providerOverride?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      label: "Trip planning",
      model: "openai/gpt-test-a",
    });
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    expect(renamed.payload?.entry).toMatchObject({
      label: "Trip planning",
      modelOverride: "gpt-test-a",
      providerOverride: "openai",
    });

    const archived = await rpcReq<{ ok: true; entry: { archivedAt?: number } }>(
      ws,
      "sessions.patch",
      { key: "agent:main:topic-b", archived: true, expectedSessionId: "sess-topic-b" },
    );
    expect(archived.ok).toBe(true);
    expect(archived.payload?.entry.archivedAt).toEqual(expect.any(Number));

    const unflaggedDeleteDenied = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:topic-b",
    });
    expect(unflaggedDeleteDenied.ok).toBe(false);
    expect(unflaggedDeleteDenied.error?.message).toContain("missing scope: operator.admin");

    const activeDeleteDenied = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:topic-a",
      archivedOnly: true,
    });
    expect(activeDeleteDenied.ok).toBe(false);
    expect(activeDeleteDenied.error?.message).toContain("Archive it first");

    for (const deleted of [true, false]) {
      const archivedDeleted = await rpcReq(ws, "sessions.delete", {
        key: "agent:main:topic-b",
        deleteTranscript: true,
        archivedOnly: true,
      });
      expect(archivedDeleted).toMatchObject({ ok: true, payload: { deleted } });
    }
    const adminFieldDenied = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      sendPolicy: "deny",
    });
    expect(adminFieldDenied.ok).toBe(false);
    expect(adminFieldDenied.error?.message).toContain("missing scope: operator.admin");

    const mixedFieldsDenied = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      label: "Sneaky",
      model: null,
      verboseLevel: "full",
    });
    expect(mixedFieldsDenied.ok).toBe(false);
    expect(mixedFieldsDenied.error?.message).toContain("missing scope: operator.admin");
    expect(loadSessionEntry({ sessionKey: "agent:main:topic-a", storePath })).toMatchObject({
      label: "Trip planning",
      modelOverride: "gpt-test-a",
      providerOverride: "openai",
    });
    // Sticky configured-default persistence is handler policy and is covered by
    // sessions-mutations.sticky-model.test.ts; this dispatch proof asserts session state only.
  } finally {
    ws.close();
  }
});

test("chat.inject writes to the transcript owner after the requested row's facts are cached", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "8f14e45f-ceea-4e7a-9f8b-2d5c6b1a0e93";
  const baseKey = "agent:main:cron:3f1c9a52-7d4e-4b8a-9c21-5e6f7a8b9c0d";
  const runKey = `${baseKey}:run:${sessionId}`;
  await writeSessionStore({
    entries: {
      [baseKey]: { sessionId, updatedAt: 1 },
      [runKey]: { sessionId, updatedAt: 2 },
    },
  });
  await seedLinearTranscript({ contents: ["cron run"], sessionId, sessionKey: runKey, storePath });
  const ownerRows = () => loadTranscriptRows({ sessionId, sessionKey: runKey, storePath });
  const rowsBefore = (await ownerRows()).length;
  const { ws } = await openClient();
  try {
    // Reading the base row must not make it the owner of the shared transcript.
    expect((await rpcReq(ws, "sessions.abort", { key: baseKey })).ok).toBe(true);
    for (const message of ["first", "second"]) {
      const injected = await rpcReq(ws, "chat.inject", { sessionKey: baseKey, message });
      expect([injected.ok, injected.error]).toEqual([true, undefined]);
    }
    expect((await ownerRows()).slice(rowsBefore)).toMatchObject([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "first" }] },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      },
    ]);
  } finally {
    ws.close();
  }
});

test.each([false, true])(
  "archiving pauses named bindings and refuses the main session (global=%s)",
  async (global) => {
    const storePath = global
      ? (await createSelectedGlobalSessionStore()).mainStorePath
      : (await createSessionStoreDir()).storePath;
    const key = global ? "global" : "agent:main:subagent:cronbound";
    const now = Date.now();
    await writeSessionStore({
      storePath,
      agentId: "main",
      entries: {
        ...(global ? {} : { main: { sessionId: "sess-main", updatedAt: now } }),
        [key]: {
          sessionId: "sess-bound",
          updatedAt: now,
          ...(global ? {} : { spawnedBy: "agent:main:main" }),
        },
      },
    });
    const jobs = [
      { id: "bound", agentId: "main", enabled: true, sessionTarget: `session:${key}` },
      { id: "other-agent", agentId: "work", enabled: true, sessionTarget: "session:global" },
      {
        id: "qualified",
        agentId: "main",
        enabled: true,
        sessionTarget: "session:agent:main:global",
      },
      { id: "elsewhere", enabled: true, sessionTarget: "isolated" },
    ] as unknown as CronJob[];
    const update = vi.fn(
      async (id: string, _patch: unknown, precondition: (job: CronJob, nowMs: number) => void) => {
        const current = jobs.find((candidate) => candidate.id === id);
        if (!current) {
          throw new Error(`cron job not found: ${id}`);
        }
        precondition(current, Date.now());
        return current;
      },
    );
    const cron = {
      list: async () => jobs,
      updateWithPrecondition: update,
      getDefaultAgentId: () => "main",
    };

    const archived = await directSessionHandlerReq(
      "sessions.patch",
      {
        key,
        agentId: "main",
        archived: true,
        expectedSessionId: "sess-bound",
      },
      { context: { cron } },
    );
    if (global) {
      expect(archived).toMatchObject({
        ok: false,
        error: { message: "Cannot archive an agent's main session." },
      });
      expect(update).not.toHaveBeenCalled();
      return;
    }
    expect([archived.ok, archived.error]).toEqual([true, undefined]);
    expect(update.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["bound", { enabled: false }],
    ]);

    // Restoring must not silently re-arm schedules that archive disabled.
    update.mockClear();
    const restored = await directSessionHandlerReq(
      "sessions.patch",
      {
        key,
        agentId: "main",
        archived: false,
        expectedSessionId: "sess-bound",
      },
      { context: { cron } },
    );
    expect(restored.ok).toBe(true);
    expect(update).not.toHaveBeenCalled();

    // Cron mutations are admin surface: a write-scoped operator can archive but
    // must not cascade into disabling admin-managed schedules.
    const writeScopedClient = {
      connect: { scopes: ["operator.write"] },
    } as unknown as NonNullable<Parameters<typeof directSessionHandlerReq>[2]>["client"];
    const writeScopedArchive = await directSessionHandlerReq(
      "sessions.patch",
      {
        key,
        agentId: "main",
        archived: true,
        expectedSessionId: "sess-bound",
      },
      { context: { cron }, client: writeScopedClient },
    );
    expect(writeScopedArchive.ok).toBe(true);
    expect(update).not.toHaveBeenCalled();
  },
);
