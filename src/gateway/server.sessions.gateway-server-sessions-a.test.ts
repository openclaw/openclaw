import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { isSessionPatchEvent, type InternalHookEvent } from "../hooks/internal-hooks.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import {
  connectOk,
  embeddedRunMock,
  installGatewayTestHooks,
  piSdkMock,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
} from "./test-helpers.js";

async function getSessionsHandlers() {
  return (await import("./server-methods/sessions.js")).sessionsHandlers;
}

const sessionCleanupMocks = vi.hoisted(() => ({
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
  stopSubagentsForRequester: vi.fn(() => ({ stopped: 0 })),
}));

const bootstrapCacheMocks = vi.hoisted(() => ({
  clearBootstrapSnapshot: vi.fn(),
}));

const sessionHookMocks = vi.hoisted(() => ({
  triggerInternalHook: vi.fn(async (_event: unknown) => {}),
}));

const subagentLifecycleHookMocks = vi.hoisted(() => ({
  runSubagentEnded: vi.fn(async () => {}),
}));

const subagentLifecycleHookState = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
}));

const threadBindingMocks = vi.hoisted(() => ({
  unbindThreadBindingsBySessionKey: vi.fn((_params?: unknown) => []),
}));
const acpRuntimeMocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getAcpRuntimeBackend: vi.fn(),
  requireAcpRuntimeBackend: vi.fn(),
}));
const acpManagerMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
}));
const browserSessionTabMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

vi.mock("../auto-reply/reply/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/reply/queue.js")>(
    "../auto-reply/reply/queue.js",
  );
  return {
    ...actual,
    clearSessionQueues: sessionCleanupMocks.clearSessionQueues,
  };
});

vi.mock("../auto-reply/reply/abort.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/reply/abort.js")>(
    "../auto-reply/reply/abort.js",
  );
  return {
    ...actual,
    stopSubagentsForRequester: sessionCleanupMocks.stopSubagentsForRequester,
  };
});

vi.mock("../agents/bootstrap-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/bootstrap-cache.js")>();
  return {
    ...actual,
    clearBootstrapSnapshot: bootstrapCacheMocks.clearBootstrapSnapshot,
  };
});

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook: sessionHookMocks.triggerInternalHook,
  };
});

vi.mock("../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/hook-runner-global.js")>();
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(() => ({
      hasHooks: (hookName: string) =>
        hookName === "subagent_ended" && subagentLifecycleHookState.hasSubagentEndedHook,
      runSubagentEnded: subagentLifecycleHookMocks.runSubagentEnded,
    })),
  };
});

vi.mock("../plugins/runtime/runtime-discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime/runtime-discord.js")>();
  return {
    ...actual,
    createRuntimeDiscord: () => {
      const runtime = actual.createRuntimeDiscord();
      return {
        ...runtime,
        threadBindings: {
          ...runtime.threadBindings,
          unbindBySessionKey: (params: unknown) =>
            threadBindingMocks.unbindThreadBindingsBySessionKey(params),
        },
      };
    },
  };
});

vi.mock("../acp/runtime/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/runtime/registry.js")>();
  return {
    ...actual,
    getAcpRuntimeBackend: acpRuntimeMocks.getAcpRuntimeBackend,
    requireAcpRuntimeBackend: (backendId?: string) => {
      const backend = acpRuntimeMocks.requireAcpRuntimeBackend(backendId);
      if (!backend) {
        throw new Error("missing mocked ACP backend");
      }
      return backend;
    },
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: acpManagerMocks.cancelSession,
    closeSession: acpManagerMocks.closeSession,
  }),
}));

vi.mock("../browser/session-tab-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser/session-tab-registry.js")>();
  return {
    ...actual,
    closeTrackedBrowserTabsForSessions: browserSessionTabMocks.closeTrackedBrowserTabsForSessions,
  };
});

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness;
let sharedSessionStoreDir: string;
let sessionStoreCaseSeq = 0;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
  sharedSessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-"));
});

afterAll(async () => {
  await harness.close();
  await fs.rm(sharedSessionStoreDir, { recursive: true, force: true });
});

const openClient = async (opts?: Parameters<typeof connectOk>[1]) => await harness.openClient(opts);

async function createSessionStoreDir() {
  const dir = path.join(sharedSessionStoreDir, `case-${sessionStoreCaseSeq++}`);
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return { dir, storePath };
}

async function writeSingleLineSession(dir: string, sessionId: string, content: string) {
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content })}\n`,
    "utf-8",
  );
}

async function seedActiveMainSession() {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
  return { dir, storePath };
}

function expectActiveRunCleanup(
  requesterSessionKey: string,
  expectedQueueKeys: string[],
  sessionId: string,
) {
  expect(sessionCleanupMocks.stopSubagentsForRequester).toHaveBeenCalledWith({
    cfg: expect.any(Object),
    requesterSessionKey,
  });
  expect(sessionCleanupMocks.clearSessionQueues).toHaveBeenCalledTimes(1);
  const clearedKeys = (
    sessionCleanupMocks.clearSessionQueues.mock.calls as unknown as Array<[string[]]>
  )[0]?.[0];
  expect(clearedKeys).toEqual(expect.arrayContaining(expectedQueueKeys));
  expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
  expect(embeddedRunMock.waitCalls).toEqual([sessionId]);
}

async function getMainPreviewEntry(ws: import("ws").WebSocket) {
  const preview = await rpcReq<{
    previews: Array<{
      key: string;
      status: string;
      items: Array<{ role: string; text: string }>;
    }>;
  }>(ws, "sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry?.key).toBe("main");
  expect(entry?.status).toBe("ok");
  return entry;
}

function isInternalHookEvent(value: unknown): value is InternalHookEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.sessionKey === "string" &&
    Array.isArray(candidate.messages) &&
    typeof candidate.context === "object" &&
    candidate.context !== null
  );
}

describe("gateway server sessions", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    sessionCleanupMocks.clearSessionQueues.mockClear();
    sessionCleanupMocks.stopSubagentsForRequester.mockClear();
    bootstrapCacheMocks.clearBootstrapSnapshot.mockReset();
    sessionHookMocks.triggerInternalHook.mockClear();
    subagentLifecycleHookMocks.runSubagentEnded.mockClear();
    subagentLifecycleHookState.hasSubagentEndedHook = true;
    threadBindingMocks.unbindThreadBindingsBySessionKey.mockClear();
    acpRuntimeMocks.cancel.mockClear();
    acpRuntimeMocks.close.mockClear();
    acpRuntimeMocks.getAcpRuntimeBackend.mockReset();
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue(null);
    acpRuntimeMocks.requireAcpRuntimeBackend.mockReset();
    acpRuntimeMocks.requireAcpRuntimeBackend.mockImplementation((backendId?: string) =>
      acpRuntimeMocks.getAcpRuntimeBackend(backendId),
    );
    acpManagerMocks.cancelSession.mockClear();
    acpManagerMocks.closeSession.mockClear();
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockClear();
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockResolvedValue(0);
  });

  test("sessions.create stores dashboard session model and parent linkage, and creates a transcript", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-parent",
          updatedAt: Date.now(),
        },
      },
    });
    const { ws } = await openClient();

    const created = await rpcReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        label?: string;
        providerOverride?: string;
        modelOverride?: string;
        parentSessionKey?: string;
      };
    }>(ws, "sessions.create", {
      agentId: "ops",
      label: "Dashboard Chat",
      model: "openai/gpt-test-a",
      parentSessionKey: "main",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
    expect(created.payload?.entry?.label).toBe("Dashboard Chat");
    expect(created.payload?.entry?.providerOverride).toBe("openai");
    expect(created.payload?.entry?.modelOverride).toBe("gpt-test-a");
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const rawStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      {
        sessionId?: string;
        label?: string;
        providerOverride?: string;
        modelOverride?: string;
        parentSessionKey?: string;
      }
    >;
    const key = created.payload?.key as string;
    expect(rawStore[key]).toMatchObject({
      sessionId: created.payload?.sessionId,
      label: "Dashboard Chat",
      providerOverride: "openai",
      modelOverride: "gpt-test-a",
      parentSessionKey: "agent:main:main",
    });

    const transcriptPath = path.join(dir, `${created.payload?.sessionId}.jsonl`);
    const transcript = await fs.readFile(transcriptPath, "utf-8");
    const [headerLine] = transcript.trim().split(/\r?\n/, 1);
    expect(JSON.parse(headerLine) as { type?: string; id?: string }).toMatchObject({
      type: "session",
      id: created.payload?.sessionId,
    });

    ws.close();
  });

  test("sessions.create accepts an explicit key for persistent dashboard sessions", async () => {
    await createSessionStoreDir();
    const { ws } = await openClient();

    const key = "agent:ops-agent:dashboard:direct:subagent-orchestrator";
    const created = await rpcReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        label?: string;
      };
    }>(ws, "sessions.create", {
      key,
      label: "Dashboard Orchestrator",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe(key);
    expect(created.payload?.entry?.label).toBe("Dashboard Orchestrator");
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    ws.close();
  });

  test("sessions.create rejects unknown parentSessionKey", async () => {
    await createSessionStoreDir();
    const { ws } = await openClient();

    const created = await rpcReq(ws, "sessions.create", {
      agentId: "ops",
      parentSessionKey: "agent:main:missing",
    });

    expect(created.ok).toBe(false);
    expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
      "unknown parent session",
    );

    ws.close();
  });

  test("sessions.create can start the first agent turn from an initial task", async () => {
    await createSessionStoreDir();
    const { ws } = await openClient();

    const created = await rpcReq<{
      key?: string;
      sessionId?: string;
      runStarted?: boolean;
      runId?: string;
      messageSeq?: number;
    }>(ws, "sessions.create", {
      agentId: "ops",
      label: "Dashboard Chat",
      task: "hello from create",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.payload?.runStarted).toBe(true);
    expect(created.payload?.runId).toBeTruthy();
    expect(created.payload?.messageSeq).toBe(1);

    ws.close();
  });

  test("sessions.list surfaces transcript usage fallbacks and parent child relationships", async () => {
    const { dir } = await createSessionStoreDir();
    testState.agentConfig = {
      models: {
        "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
      },
    };
    await fs.writeFile(
      path.join(dir, "sess-parent.jsonl"),
      `${JSON.stringify({ type: "session", version: 1, id: "sess-parent" })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-child.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-child" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_000,
              cost: { total: 0.0042 },
            },
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-parent",
          updatedAt: Date.now(),
        },
        "dashboard:child": {
          sessionId: "sess-child",
          updatedAt: Date.now() - 1_000,
          modelProvider: "anthropic",
          model: "claude-sonnet-4-6",
          parentSessionKey: "agent:main:main",
          totalTokens: 0,
          totalTokensFresh: false,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    });

    const { ws } = await openClient();
    const listed = await rpcReq<{
      sessions: Array<{
        key: string;
        parentSessionKey?: string;
        childSessions?: string[];
        totalTokens?: number;
        totalTokensFresh?: boolean;
        contextTokens?: number;
        estimatedCostUsd?: number;
      }>;
    }>(ws, "sessions.list", {});

    expect(listed.ok).toBe(true);
    const parent = listed.payload?.sessions.find((session) => session.key === "agent:main:main");
    const child = listed.payload?.sessions.find(
      (session) => session.key === "agent:main:dashboard:child",
    );
    expect(parent?.childSessions).toEqual(["agent:main:dashboard:child"]);
    expect(child?.parentSessionKey).toBe("agent:main:main");
    expect(child?.totalTokens).toBe(3_000);
    expect(child?.totalTokensFresh).toBe(true);
    expect(child?.contextTokens).toBe(1_048_576);
    expect(child?.estimatedCostUsd).toBe(0.0042);

    ws.close();
  });

  test("sessions.changed mutation events include live usage metadata", async () => {
    const { dir } = await createSessionStoreDir();
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          id: "msg-usage-zero",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            usage: {
              input: 5_107,
              output: 1_827,
              cacheRead: 1_536,
              cacheWrite: 0,
              cost: { total: 0 },
            },
            timestamp: Date.now(),
          },
        }),
      ].join("\n"),
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          contextTokens: 123_456,
          totalTokens: 0,
          totalTokensFresh: false,
        },
      },
    });

    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();
    const sessionsHandlers = await getSessionsHandlers();
    await sessionsHandlers["sessions.patch"]({
      req: {} as never,
      params: {
        key: "main",
        label: "Renamed",
      },
      respond,
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        loadGatewayModelCatalog: async () => ({ providers: [] }),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, key: "agent:main:main" }),
      undefined,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        reason: "patch",
        totalTokens: 6_643,
        totalTokensFresh: true,
        contextTokens: 123_456,
        estimatedCostUsd: 0,
        modelProvider: "openai-codex",
        model: "gpt-5.3-codex-spark",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  test("lists and patches session store via sessions.* RPC", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    const now = Date.now();
    const recent = now - 30_000;
    const stale = now - 15 * 60_000;

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      `${Array.from({ length: 10 })
        .map((_, idx) => JSON.stringify({ role: "user", content: `line ${idx}` }))
        .join("\n")}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-group.jsonl"),
      `${JSON.stringify({ role: "user", content: "group line 0" })}\n`,
      "utf-8",
    );

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
        },
        "agent:main:subagent:one": {
          sessionId: "sess-subagent",
          updatedAt: stale,
          spawnedBy: "agent:main:main",
        },
        global: {
          sessionId: "sess-global",
          updatedAt: now - 10_000,
        },
      },
    });

    const { ws, hello } = await openClient();
    expect((hello as { features?: { methods?: string[] } }).features?.methods).toEqual(
      expect.arrayContaining([
        "sessions.list",
        "sessions.preview",
        "sessions.patch",
        "sessions.reset",
        "sessions.delete",
        "sessions.compact",
      ]),
    );

    const resolvedByKey = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolvedByKey.ok).toBe(true);
    expect(resolvedByKey.payload?.key).toBe("agent:main:main");

    const resolvedBySessionId = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      sessionId: "sess-group",
    });
    expect(resolvedBySessionId.ok).toBe(true);
    expect(resolvedBySessionId.payload?.key).toBe("agent:main:discord:group:dev");

    const list1 = await rpcReq<{
      path: string;
      defaults?: { model?: string | null; modelProvider?: string | null };
      sessions: Array<{
        key: string;
        totalTokens?: number;
        totalTokensFresh?: boolean;
        thinkingLevel?: string;
        verboseLevel?: string;
        lastAccountId?: string;
        deliveryContext?: { channel?: string; to?: string; accountId?: string };
      }>;
    }>(ws, "sessions.list", { includeGlobal: false, includeUnknown: false });

    expect(list1.ok).toBe(true);
    expect(list1.payload?.path).toBe(storePath);
    expect(list1.payload?.sessions.some((s) => s.key === "global")).toBe(false);
    expect(list1.payload?.defaults?.modelProvider).toBe(DEFAULT_PROVIDER);
    const main = list1.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main?.totalTokens).toBeUndefined();
    expect(main?.totalTokensFresh).toBe(false);
    expect(main?.thinkingLevel).toBe("low");
    expect(main?.verboseLevel).toBe("on");
    expect(main?.lastAccountId).toBe("work");
    expect(main?.deliveryContext).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "work",
      threadId: "1737500000.123456",
    });

    const active = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      activeMinutes: 5,
    });
    expect(active.ok).toBe(true);
    expect(active.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:main"]);

    const limited = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: true,
      includeUnknown: false,
      limit: 1,
    });
    expect(limited.ok).toBe(true);
    expect(limited.payload?.sessions).toHaveLength(1);
    expect(limited.payload?.sessions[0]?.key).toBe("global");

    const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "medium",
      verboseLevel: "off",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:main:main");

    const sendPolicyPatched = await rpcReq<{
      ok: true;
      entry: { sendPolicy?: string };
    }>(ws, "sessions.patch", { key: "agent:main:main", sendPolicy: "deny" });
    expect(sendPolicyPatched.ok).toBe(true);
    expect(sendPolicyPatched.payload?.entry.sendPolicy).toBe("deny");

    const labelPatched = await rpcReq<{
      ok: true;
      entry: { label?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:subagent:one",
      label: "Briefing",
    });
    expect(labelPatched.ok).toBe(true);
    expect(labelPatched.payload?.entry.label).toBe("Briefing");

    const labelPatchedDuplicate = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:discord:group:dev",
      label: "Briefing",
    });
    expect(labelPatchedDuplicate.ok).toBe(false);

    const list2 = await rpcReq<{
      sessions: Array<{
        key: string;
        thinkingLevel?: string;
        verboseLevel?: string;
        sendPolicy?: string;
        label?: string;
        displayName?: string;
      }>;
    }>(ws, "sessions.list", {});
    expect(list2.ok).toBe(true);
    const main2 = list2.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main2?.thinkingLevel).toBe("medium");
    expect(main2?.verboseLevel).toBe("off");
    expect(main2?.sendPolicy).toBe("deny");
    const subagent = list2.payload?.sessions.find((s) => s.key === "agent:main:subagent:one");
    expect(subagent?.label).toBe("Briefing");
    expect(subagent?.displayName).toBe("Briefing");

    const clearedVerbose = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "agent:main:main",
      verboseLevel: null,
    });
    expect(clearedVerbose.ok).toBe(true);

    const list3 = await rpcReq<{
      sessions: Array<{
        key: string;
        verboseLevel?: string;
      }>;
    }>(ws, "sessions.list", {});
    expect(list3.ok).toBe(true);
    const main3 = list3.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main3?.verboseLevel).toBeUndefined();

    const listByLabel = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      label: "Briefing",
    });
    expect(listByLabel.ok).toBe(true);
    expect(listByLabel.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

    const resolvedByLabel = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      label: "Briefing",
      agentId: "main",
    });
    expect(resolvedByLabel.ok).toBe(true);
    expect(resolvedByLabel.payload?.key).toBe("agent:main:subagent:one");

    const spawnedOnly = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      spawnedBy: "agent:main:main",
    });
    expect(spawnedOnly.ok).toBe(true);
    expect(spawnedOnly.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

    const spawnedPatched = await rpcReq<{
      ok: true;
      entry: { spawnedBy?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:subagent:two",
      spawnedBy: "agent:main:main",
    });
    expect(spawnedPatched.ok).toBe(true);
    expect(spawnedPatched.payload?.entry.spawnedBy).toBe("agent:main:main");

    const acpPatched = await rpcReq<{
      ok: true;
      entry: { spawnedBy?: string; spawnDepth?: number };
    }>(ws, "sessions.patch", {
      key: "agent:main:acp:child",
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
    });
    expect(acpPatched.ok).toBe(true);
    expect(acpPatched.payload?.entry.spawnedBy).toBe("agent:main:main");
    expect(acpPatched.payload?.entry.spawnDepth).toBe(1);

    const spawnedPatchedInvalidKey = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      spawnedBy: "agent:main:main",
    });
    expect(spawnedPatchedInvalidKey.ok).toBe(false);

    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
    const modelPatched = await rpcReq<{
      ok: true;
      entry: {
        modelOverride?: string;
        providerOverride?: string;
        model?: string;
        modelProvider?: string;
      };
      resolved?: { model?: string; modelProvider?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:main",
      model: "openai/gpt-test-a",
    });
    expect(modelPatched.ok).toBe(true);
    expect(modelPatched.payload?.entry.modelOverride).toBe("gpt-test-a");
    expect(modelPatched.payload?.entry.providerOverride).toBe("openai");
    expect(modelPatched.payload?.entry.model).toBeUndefined();
    expect(modelPatched.payload?.entry.modelProvider).toBeUndefined();
    expect(modelPatched.payload?.resolved?.modelProvider).toBe("openai");
    expect(modelPatched.payload?.resolved?.model).toBe("gpt-test-a");

    const listAfterModelPatch = await rpcReq<{
      sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
    }>(ws, "sessions.list", {});
    expect(listAfterModelPatch.ok).toBe(true);
    const mainAfterModelPatch = listAfterModelPatch.payload?.sessions.find(
      (session) => session.key === "agent:main:main",
    );
    expect(mainAfterModelPatch?.modelProvider).toBe("openai");
    expect(mainAfterModelPatch?.model).toBe("gpt-test-a");

    const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
      key: "agent:main:main",
      maxLines: 3,
    });
    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(true);
    const compactedLines = (await fs.readFile(path.join(dir, "sess-main.jsonl"), "utf-8"))
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(compactedLines).toHaveLength(3);
    const filesAfterCompact = await fs.readdir(dir);
    expect(filesAfterCompact.some((f) => f.startsWith("sess-main.jsonl.bak."))).toBe(true);

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    const listAfterDelete = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {});
    expect(listAfterDelete.ok).toBe(true);
    expect(
      listAfterDelete.payload?.sessions.some((s) => s.key === "agent:main:discord:group:dev"),
    ).toBe(false);
    const filesAfterDelete = await fs.readdir(dir);
    expect(filesAfterDelete.some((f) => f.startsWith("sess-group.jsonl.deleted."))).toBe(true);

    const reset = await rpcReq<{
      ok: true;
      key: string;
      entry: {
        sessionId: string;
        modelProvider?: string;
        model?: string;
        lastAccountId?: string;
        lastThreadId?: string | number;
      };
    }>(ws, "sessions.reset", { key: "agent:main:main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
    expect(reset.payload?.entry.modelProvider).toBe("openai");
    expect(reset.payload?.entry.model).toBe("gpt-test-a");
    expect(reset.payload?.entry.lastAccountId).toBe("work");
    expect(reset.payload?.entry.lastThreadId).toBe("1737500000.123456");
    const storeAfterReset = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { lastAccountId?: string; lastThreadId?: string | number }
    >;
    expect(storeAfterReset["agent:main:main"]?.lastAccountId).toBe("work");
    expect(storeAfterReset["agent:main:main"]?.lastThreadId).toBe("1737500000.123456");
    const filesAfterReset = await fs.readdir(dir);
    expect(filesAfterReset.some((f) => f.startsWith("sess-main.jsonl.reset."))).toBe(true);

    const badThinking = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "banana",
    });
    expect(badThinking.ok).toBe(false);
    expect((badThinking.error as { message?: unknown } | undefined)?.message ?? "").toMatch(
      /invalid thinkinglevel/i,
    );

    ws.close();
  });

  test("sessions.preview returns transcript previews", async () => {
    const { dir } = await createSessionStoreDir();
    const sessionId = "sess-preview";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const lines = createToolSummaryPreviewTranscriptLines(sessionId);
    await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");

    await writeSessionStore({
      entries: {
        main: {
          sessionId,
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();
    const entry = await getMainPreviewEntry(ws);
    expect(entry?.items.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(entry?.items[1]?.text).toContain("call weather");

    ws.close();
  });

  test("sessions.reset recomputes model from defaults instead of stale runtime model", async () => {
    await createSessionStoreDir();
    testState.agentConfig = {
      model: {
        primary: "openai/gpt-test-a",
      },
    };

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-stale-model",
          updatedAt: Date.now(),
          modelProvider: "qwencode",
          model: "qwen3.5-plus-2026-02-15",
          contextTokens: 123456,
        },
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{
      ok: true;
      key: string;
      entry: { sessionId: string; modelProvider?: string; model?: string; contextTokens?: number };
    }>(ws, "sessions.reset", { key: "main" });

    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-stale-model");
    expect(reset.payload?.entry.modelProvider).toBe("openai");
    expect(reset.payload?.entry.model).toBe("gpt-test-a");
    expect(reset.payload?.entry.contextTokens).toBeUndefined();

    ws.close();
  });

  test("sessions.preview resolves legacy mixed-case main alias with custom mainKey", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };
    const sessionId = "sess-legacy-main";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "assistant", content: "Legacy alias transcript" } }),
    ];
    await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:ops:MAIN": {
            sessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { ws } = await openClient();
    const entry = await getMainPreviewEntry(ws);
    expect(entry?.items[0]?.text).toContain("Legacy alias transcript");

    ws.close();
  });

  test("sessions.preview prefers the freshest duplicate row for a legacy mixed-case main alias", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };

    const staleTranscriptPath = path.join(dir, "sess-stale-main.jsonl");
    const freshTranscriptPath = path.join(dir, "sess-fresh-main.jsonl");
    await fs.writeFile(
      staleTranscriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-stale-main" }),
        JSON.stringify({ message: { role: "assistant", content: "stale preview" } }),
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      freshTranscriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-fresh-main" }),
        JSON.stringify({ message: { role: "assistant", content: "fresh preview" } }),
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:ops:work": {
            sessionId: "sess-stale-main",
            updatedAt: 1,
          },
          "agent:ops:WORK": {
            sessionId: "sess-fresh-main",
            updatedAt: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { ws } = await openClient();
    const entry = await getMainPreviewEntry(ws);
    expect(entry?.items[0]?.text).toContain("fresh preview");

    ws.close();
  });

  test("sessions.resolve and mutators clean legacy main-alias ghost keys", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };
    const sessionId = "sess-alias-cleanup";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(
      transcriptPath,
      `${Array.from({ length: 8 })
        .map((_, idx) => JSON.stringify({ role: "assistant", content: `line ${idx}` }))
        .join("\n")}\n`,
      "utf-8",
    );

    const writeRawStore = async (store: Record<string, unknown>) => {
      await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
    };
    const readStore = async () =>
      JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, Record<string, unknown>>;

    await writeRawStore({
      "agent:ops:MAIN": { sessionId, updatedAt: Date.now() - 2_000 },
      "agent:ops:Main": { sessionId, updatedAt: Date.now() - 1_000 },
    });

    const { ws } = await openClient();

    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");
    let store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);
    expect(store["agent:ops:work"]?.thinkingLevel).toBe("medium");

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
      key: "main",
      maxLines: 3,
    });
    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(true);
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:ops:work");
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    ws.close();
  });

  test("sessions.resolve by sessionId ignores fuzzy-search list limits and returns the exact match", async () => {
    await createSessionStoreDir();
    const now = Date.now();
    const entries: Record<string, { sessionId: string; updatedAt: number; label?: string }> = {
      "agent:main:subagent:target": {
        sessionId: "sess-target-exact",
        updatedAt: now - 20_000,
      },
    };
    for (let i = 0; i < 9; i += 1) {
      entries[`agent:main:subagent:noisy-${i}`] = {
        sessionId: `sess-noisy-${i}`,
        updatedAt: now - i * 1_000,
        label: `sess-target-exact noisy ${i}`,
      };
    }
    await writeSessionStore({ entries });

    const { ws } = await openClient();
    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      sessionId: "sess-target-exact",
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:main:subagent:target");
  });

  test("sessions.resolve by key respects spawnedBy visibility filters", async () => {
    await createSessionStoreDir();
    const now = Date.now();
    await writeSessionStore({
      entries: {
        "agent:main:subagent:visible-parent": {
          sessionId: "sess-visible-parent",
          updatedAt: now - 3_000,
          spawnedBy: "agent:main:main",
        },
        "agent:main:subagent:hidden-parent": {
          sessionId: "sess-hidden-parent",
          updatedAt: now - 2_000,
          spawnedBy: "agent:main:main",
        },
        "agent:main:subagent:shared-child-key-filter": {
          sessionId: "sess-shared-child-key-filter",
          updatedAt: now - 1_000,
          spawnedBy: "agent:main:subagent:hidden-parent",
        },
      },
    });

    const { ws } = await openClient();
    const resolved = await rpcReq(ws, "sessions.resolve", {
      key: "agent:main:subagent:shared-child-key-filter",
      spawnedBy: "agent:main:subagent:visible-parent",
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.error?.message).toContain(
      "No session found: agent:main:subagent:shared-child-key-filter",
    );
  });

  test("sessions.delete rejects main and aborts active runs", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSingleLineSession(dir, "sess-active", "active");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
        "discord:group:dev": {
          sessionId: "sess-active",
          updatedAt: Date.now(),
        },
      },
    });

    embeddedRunMock.activeIds.add("sess-active");
    embeddedRunMock.waitResults.set("sess-active", true);

    const { ws } = await openClient();

    const mainDelete = await rpcReq(ws, "sessions.delete", { key: "main" });
    expect(mainDelete.ok).toBe(false);

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expectActiveRunCleanup(
      "agent:main:discord:group:dev",
      ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
      "sess-active",
    );
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      sessionKeys: expect.arrayContaining([
        "discord:group:dev",
        "agent:main:discord:group:dev",
        "sess-active",
      ]),
      onWarn: expect.any(Function),
    });
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
      {
        targetSessionKey: "agent:main:discord:group:dev",
        targetKind: "acp",
        reason: "session-delete",
        sendFarewell: true,
        outcome: "deleted",
      },
      {
        childSessionKey: "agent:main:discord:group:dev",
      },
    );
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:discord:group:dev",
      targetKind: "acp",
      reason: "session-delete",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.delete closes ACP runtime handles before removing ACP sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSingleLineSession(dir, "sess-acp", "acp");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
        "discord:group:dev": {
          sessionId: "sess-acp",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:delete",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        },
      },
    });
    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(acpManagerMocks.closeSession).toHaveBeenCalledWith({
      allowBackendUnavailable: true,
      cfg: expect.any(Object),
      requireAcpSession: false,
      reason: "session-delete",
      sessionKey: "agent:main:discord:group:dev",
    });
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      reason: "session-delete",
      sessionKey: "agent:main:discord:group:dev",
    });

    ws.close();
  });

  test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:subagent:missing",
    });

    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(false);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();

    ws.close();
  });

  test("sessions.delete emits subagent targetKind for subagent sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:subagent:worker",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
      | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
      | undefined;
    expect(event).toMatchObject({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      outcome: "deleted",
    });
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:subagent:worker",
      emitLifecycleHooks: false,
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.delete directly unbinds thread bindings when hooks are unavailable", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });
    subagentLifecycleHookState.hasSubagentEndedHook = false;

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:subagent:worker",
    });
    expect(deleted.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.reset aborts active runs and clears queues", async () => {
    await seedActiveMainSession();
    const waitCallCountAtSnapshotClear: number[] = [];
    bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
      waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
    });

    embeddedRunMock.activeIds.add("sess-main");
    embeddedRunMock.waitResults.set("sess-main", true);

    const { ws } = await openClient();

    const reset = await rpcReq<{ ok: true; key: string; entry: { sessionId: string } }>(
      ws,
      "sessions.reset",
      {
        key: "main",
      },
    );
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
    expectActiveRunCleanup(
      "agent:main:main",
      ["main", "agent:main:main", "sess-main"],
      "sess-main",
    );
    expect(waitCallCountAtSnapshotClear).toEqual([1]);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      sessionKeys: expect.arrayContaining(["main", "agent:main:main", "sess-main"]),
      onWarn: expect.any(Function),
    });
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
      {
        targetSessionKey: "agent:main:main",
        targetKind: "acp",
        reason: "session-reset",
        sendFarewell: true,
        outcome: "reset",
      },
      {
        childSessionKey: "agent:main:main",
      },
    );
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:main",
      targetKind: "acp",
      reason: "session-reset",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.reset closes ACP runtime handles for ACP sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:reset",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        },
      },
    });
    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(true);
    expect(acpManagerMocks.closeSession).toHaveBeenCalledWith({
      allowBackendUnavailable: true,
      cfg: expect.any(Object),
      requireAcpSession: false,
      reason: "session-reset",
      sessionKey: "agent:main:main",
    });

    ws.close();
  });

  test("sessions.reset does not emit lifecycle events when key does not exist", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string; entry: { sessionId: string } }>(
      ws,
      "sessions.reset",
      {
        key: "agent:main:subagent:missing",
      },
    );

    expect(reset.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();

    ws.close();
  });

  test("sessions.reset emits subagent targetKind for subagent sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string; entry: { sessionId: string } }>(
      ws,
      "sessions.reset",
      {
        key: "agent:main:subagent:worker",
      },
    );
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:subagent:worker");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-subagent");
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
      | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
      | undefined;
    expect(event).toMatchObject({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-reset",
      outcome: "reset",
    });
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-reset",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.reset directly unbinds thread bindings when hooks are unavailable", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    subagentLifecycleHookState.hasSubagentEndedHook = false;

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:main",
      targetKind: "acp",
      reason: "session-reset",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.reset emits internal command hook with reason", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", {
      key: "main",
      reason: "new",
    });
    expect(reset.ok).toBe(true);
    expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
    const event = (
      sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as { context?: { previousSessionEntry?: unknown } } | undefined;
    if (!event) {
      throw new Error("expected session hook event");
    }
    expect(event).toMatchObject({
      type: "command",
      action: "new",
      sessionKey: "agent:main:main",
      context: {
        commandSource: "gateway:sessions.reset",
      },
    });
    expect(event.context?.previousSessionEntry).toMatchObject({ sessionId: "sess-main" });
    ws.close();
  });

  test("sessions.reset returns unavailable when active run does not stop", async () => {
    const { dir, storePath } = await seedActiveMainSession();
    const waitCallCountAtSnapshotClear: number[] = [];
    bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
      waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
    });

    embeddedRunMock.activeIds.add("sess-main");
    embeddedRunMock.waitResults.set("sess-main", false);

    const { ws } = await openClient();

    const reset = await rpcReq(ws, "sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(false);
    expect(reset.error?.code).toBe("UNAVAILABLE");
    expect(reset.error?.message ?? "").toMatch(/still active/i);
    expectActiveRunCleanup(
      "agent:main:main",
      ["main", "agent:main:main", "sess-main"],
      "sess-main",
    );
    expect(waitCallCountAtSnapshotClear).toEqual([1]);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:main"]?.sessionId).toBe("sess-main");
    const filesAfterResetAttempt = await fs.readdir(dir);
    expect(filesAfterResetAttempt.some((f) => f.startsWith("sess-main.jsonl.reset."))).toBe(false);

    ws.close();
  });

  test("sessions.delete returns unavailable when active run does not stop", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-active", "active");

    await writeSessionStore({
      entries: {
        "discord:group:dev": {
          sessionId: "sess-active",
          updatedAt: Date.now(),
        },
      },
    });

    embeddedRunMock.activeIds.add("sess-active");
    embeddedRunMock.waitResults.set("sess-active", false);

    const { ws } = await openClient();

    const deleted = await rpcReq(ws, "sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(false);
    expect(deleted.error?.code).toBe("UNAVAILABLE");
    expect(deleted.error?.message ?? "").toMatch(/still active/i);
    expectActiveRunCleanup(
      "agent:main:discord:group:dev",
      ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
      "sess-active",
    );
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:discord:group:dev"]?.sessionId).toBe("sess-active");
    const filesAfterDeleteAttempt = await fs.readdir(dir);
    expect(filesAfterDeleteAttempt.some((f) => f.startsWith("sess-active.jsonl.deleted."))).toBe(
      false,
    );

    ws.close();
  });

  test("webchat clients cannot patch or delete sessions", async () => {
    await createSessionStoreDir();

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-group",
          updatedAt: Date.now(),
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`, {
      headers: { origin: `http://127.0.0.1:${harness.port}` },
    });
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
      scopes: ["operator.admin"],
    });

    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:discord:group:dev",
      label: "should-fail",
    });
    expect(patched.ok).toBe(false);
    expect(patched.error?.message ?? "").toMatch(/webchat clients cannot patch sessions/i);

    const deleted = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(false);
    expect(deleted.error?.message ?? "").toMatch(/webchat clients cannot delete sessions/i);

    ws.close();
  });

  test("session:patch hook fires with correct context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-patch-hook-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-hook-test",
          updatedAt: Date.now(),
          label: "original-label",
        },
      },
    });

    sessionHookMocks.triggerInternalHook.mockClear();

    const { ws } = await openClient();

    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "updated-label",
    });

    expect(patched.ok).toBe(true);
    expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session",
        action: "patch",
        sessionKey: expect.stringMatching(/agent:main:main/),
        context: expect.objectContaining({
          sessionEntry: expect.objectContaining({
            sessionId: "sess-hook-test",
            label: "updated-label",
          }),
          patch: expect.objectContaining({
            label: "updated-label",
          }),
          cfg: expect.any(Object),
        }),
      }),
    );

    ws.close();
  });

  test("session:patch hook does not fire for webchat clients", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-webchat-hook-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-webchat-test",
          updatedAt: Date.now(),
        },
      },
    });

    sessionHookMocks.triggerInternalHook.mockClear();

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`, {
      headers: { origin: `http://127.0.0.1:${harness.port}` },
    });
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
      scopes: ["operator.admin"],
    });

    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "should-not-trigger-hook",
    });

    expect(patched.ok).toBe(false);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();

    ws.close();
  });

  test("session:patch hook only fires after successful patch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-success-hook-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-success-test",
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();

    sessionHookMocks.triggerInternalHook.mockClear();

    // Test 1: Invalid patch (missing key) - hook should not fire
    const invalidPatch = await rpcReq(ws, "sessions.patch", {
      // Missing required 'key' parameter
      label: "should-fail",
    });

    expect(invalidPatch.ok).toBe(false);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();

    // Test 2: Valid patch - hook should fire
    const validPatch = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "should-succeed",
    });

    expect(validPatch.ok).toBe(true);
    expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session",
        action: "patch",
      }),
    );

    ws.close();
  });

  test("session:patch hook mutations cannot change the response path", async () => {
    await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-cfg-isolation-test",
          updatedAt: Date.now(),
        },
      },
    });

    sessionHookMocks.triggerInternalHook.mockImplementationOnce(async (event) => {
      if (!isInternalHookEvent(event) || !isSessionPatchEvent(event)) {
        return;
      }
      event.context.cfg.agents = {
        ...event.context.cfg.agents,
        defaults: {
          ...event.context.cfg.agents?.defaults,
          model: "zai/glm-4.6",
        },
      };
    });

    const { ws } = await openClient();
    const patched = await rpcReq<{
      entry: { label?: string };
      key: string;
      resolved: { modelProvider: string; model: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:main",
      label: "cfg-isolation",
    });

    expect(patched.ok).toBe(true);
    expect(patched.payload?.resolved).toEqual({
      modelProvider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(patched.payload?.entry.label).toBe("cfg-isolation");

    ws.close();
  });

  test("control-ui client can delete sessions even in webchat mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-control-ui-delete-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-group",
          updatedAt: Date.now(),
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`, {
      headers: { origin: `http://127.0.0.1:${harness.port}` },
    });
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      scopes: ["operator.admin"],
    });

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:discord:group:dev"]).toBeUndefined();

    ws.close();
  });
});
