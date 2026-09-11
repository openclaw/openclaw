/**
 * Gateway session store RPC tests.
 */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { deliveryContextFromSession } from "../utils/delivery-context.shared.js";
import { agentDiscoveryMock, rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq as directSessionHandlerReq,
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

type SessionPatchResponse = { ok: true; key: string; entry: Record<string, unknown> };

async function seedLinearTranscript(params: {
  contents: string[];
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await persistSessionTranscriptTurn(
    {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      updateMode: "none",
      messages: params.contents.map((content, index) => ({
        message: { role: "user", content, timestamp: index + 1 },
        now: Date.parse(`2026-06-19T12:00:${String(index + 1).padStart(2, "0")}.000Z`),
      })),
    },
  );
}

async function loadTranscriptRows(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  return await loadTranscriptEvents({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

test("sessions.patch validates persistent session icons", async () => {
  const invalid = await directSessionHandlerReq("sessions.patch", {
    key: "agent:main:main",
    icon: "hand",
  });
  expect(invalid.error).toEqual({
    code: "INVALID_REQUEST",
    message: "icon must be a single emoji or one of: braces, book, monitor, bot, kanban, coins",
  });
});

test("lists and patches session store via sessions.* RPC", async () => {
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
    contents: Array.from({ length: 10 }, (_, index) => `line ${index}`),
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedLinearTranscript({
    contents: ["group line 0"],
    sessionId: "sess-group",
    sessionKey: "agent:main:discord:group:dev",
    storePath,
  });
  await expect(
    loadTranscriptRows({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath,
    }),
  ).resolves.toHaveLength(11);

  const { ws, hello } = await openClient();
  const methods = (hello as { features?: { methods?: string[] } }).features?.methods ?? [];
  expect(methods).toContain("sessions.list");
  expect(methods).toContain("sessions.preview");
  expect(methods).toContain("sessions.cleanup");
  expect(methods).toContain("sessions.patch");
  expect(methods).toContain("sessions.patchMany");
  expect(methods).toContain("sessions.reset");
  expect(methods).toContain("sessions.delete");
  expect(methods).toContain("sessions.compact");
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const directContext = {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    retiredFollowupRunIds: new Map(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { debug: vi.fn() },
    loadGatewayModelCatalog: async () => agentDiscoveryMock.models,
    getRuntimeConfig,
  };
  async function directSessionReq<TPayload = unknown>(
    method: keyof typeof sessionsHandlers,
    params: Record<string, unknown>,
    coercePayload?: (payload: unknown) => TPayload,
  ): Promise<{ ok: boolean; payload?: TPayload; error?: unknown }> {
    let result:
      | {
          ok: boolean;
          payload?: TPayload;
          error?: unknown;
        }
      | undefined;
    await expectDefined(
      sessionsHandlers[method],
      "sessionsHandlers[method] test invariant",
    )({
      req: {} as never,
      params,
      respond: (ok, payload, error) => {
        result = {
          ok,
          payload:
            payload === undefined
              ? undefined
              : coercePayload
                ? coercePayload(payload)
                : (payload as TPayload),
          error,
        };
      },
      context: directContext as never,
      client: null,
      isWebchatConnect: () => false,
    });
    if (!result) {
      throw new Error(`${method} did not respond`);
    }
    return result;
  }

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
  ws.close();

  const list1 = await directSessionReq<{
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
      classification?: string;
      agentId?: string;
      accountId?: string;
      peerKind?: string;
      isMain?: boolean;
      isBackground?: boolean;
    }>;
  }>("sessions.list", { includeGlobal: false, includeUnknown: false });

  expect(list1.ok).toBe(true);
  expect(list1.payload?.sessions.map((session) => session.key)).not.toContain("global");
  expect(list1.payload?.defaults?.modelProvider).toBe("anthropic");
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
  expect(main).toMatchObject({
    classification: "main",
    agentId: "main",
    isMain: true,
    isBackground: false,
  });
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

  const active = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
    activeMinutes: 5,
  });
  expect(active.ok).toBe(true);
  expect(active.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:main"]);

  const limited = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: false,
    limit: 1,
  });
  expect(limited.ok).toBe(true);
  expect(limited.payload?.sessions).toHaveLength(1);
  expect(limited.payload?.sessions[0]?.key).toBe("global");

  const patched = await directSessionReq<SessionPatchResponse>("sessions.patch", {
    key: "agent:main:main",
    thinkingLevel: "medium",
    verboseLevel: "off",
    icon: "🦞",
  });
  expect(patched.ok).toBe(true);
  expect(patched.payload?.ok).toBe(true);
  expect(patched.payload?.key).toBe("agent:main:main");
  expect(patched.payload?.entry.icon).toBe("🦞");
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.icon).toBe("🦞");

  const sendPolicyPatched = await directSessionReq<{
    ok: true;
    entry: { sendPolicy?: string };
  }>("sessions.patch", { key: "agent:main:main", sendPolicy: "deny" });
  expect(sendPolicyPatched.ok).toBe(true);
  expect(sendPolicyPatched.payload?.entry.sendPolicy).toBe("deny");

  const labelPatched = await directSessionReq<{
    ok: true;
    entry: { label?: string };
  }>("sessions.patch", {
    key: "agent:main:subagent:one",
    label: "Briefing",
  });
  expect(labelPatched.ok).toBe(true);
  expect(labelPatched.payload?.entry.label).toBe("Briefing");

  const labelPatchedDuplicate = await directSessionReq("sessions.patch", {
    key: "agent:main:discord:group:dev",
    label: "Briefing",
  });
  expect(labelPatchedDuplicate.ok).toBe(false);

  const mainArchive = await directSessionReq("sessions.patch", {
    key: "agent:main:main",
    archived: true,
  });
  expect(mainArchive.ok).toBe(false);

  const pinned = await directSessionReq<{
    entry: { pinnedAt?: number };
  }>("sessions.patch", {
    key: "agent:main:discord:group:dev",
    pinned: true,
  });
  expect(pinned.ok).toBe(true);
  expect(pinned.payload?.entry.pinnedAt).toEqual(expect.any(Number));

  const pinnedList = await directSessionReq<{
    sessions: Array<{ key: string; pinned?: boolean }>;
  }>("sessions.list", {});
  expect(pinnedList.payload?.sessions[0]).toMatchObject({
    key: "agent:main:discord:group:dev",
    pinned: true,
  });

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

  const activeAfterArchive = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {});
  expect(activeAfterArchive.payload?.sessions.map((session) => session.key)).not.toContain(
    "agent:main:discord:group:dev",
  );
  const archivedList = await directSessionReq<{
    sessions: Array<{ key: string; archived?: boolean }>;
  }>("sessions.list", { archived: true });
  expect(archivedList.payload?.sessions).toMatchObject([
    { key: "agent:main:discord:group:dev", archived: true },
  ]);

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

  const list2 = await directSessionReq<{
    sessions: Array<{
      key: string;
      thinkingLevel?: string;
      verboseLevel?: string;
      sendPolicy?: string;
      label?: string;
      displayName?: string;
      classification?: string;
      isBackground?: boolean;
    }>;
  }>("sessions.list", {});
  expect(list2.ok).toBe(true);
  const main2 = list2.payload?.sessions.find((s) => s.key === "agent:main:main");
  expect(main2?.thinkingLevel).toBe("medium");
  expect(main2?.verboseLevel).toBe("off");
  expect(main2?.sendPolicy).toBe("deny");
  const subagent = list2.payload?.sessions.find((s) => s.key === "agent:main:subagent:one");
  expect(subagent?.label).toBe("Briefing");
  expect(subagent?.displayName).toBe("Briefing");
  expect(subagent).toMatchObject({
    classification: "subagent",
    isBackground: true,
  });

  const clearedVerbose = await directSessionReq<SessionPatchResponse>("sessions.patch", {
    key: "agent:main:main",
    verboseLevel: null,
    icon: "",
  });
  expect(clearedVerbose.ok).toBe(true);
  expect(clearedVerbose.payload?.entry).not.toHaveProperty("icon");
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).not.toHaveProperty("icon");

  const list3 = await directSessionReq<{
    sessions: Array<{
      key: string;
      verboseLevel?: string;
    }>;
  }>("sessions.list", {});
  expect(list3.ok).toBe(true);
  const main3 = list3.payload?.sessions.find((s) => s.key === "agent:main:main");
  expect(main3?.verboseLevel).toBeUndefined();

  const listByLabel = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
    label: "Briefing",
  });
  expect(listByLabel.ok).toBe(true);
  expect(listByLabel.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

  const resolvedByLabel = await directSessionReq<{ ok: true; key: string }>("sessions.resolve", {
    label: "Briefing",
    agentId: "main",
  });
  expect(resolvedByLabel.ok).toBe(true);
  expect(resolvedByLabel.payload?.key).toBe("agent:main:subagent:one");

  const spawnedOnly = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: true,
    spawnedBy: "agent:main:main",
  });
  expect(spawnedOnly.ok).toBe(true);
  expect(spawnedOnly.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

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

  const cleaned = await directSessionReq<{
    applied: true;
    missing: number;
    appliedCount: number;
  }>("sessions.cleanup", {
    enforce: true,
    fixMissing: true,
  });
  expect(cleaned.ok).toBe(true);
  expect(cleaned.payload?.missing).toBeGreaterThanOrEqual(1);
  const listAfterCleanup = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {});
  expect(listAfterCleanup.payload?.sessions.map((session) => session.key)).not.toContain(
    "agent:main:subagent:one",
  );

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
  expect(modelPatched.payload?.entry.modelOverride).toBe("gpt-test-a");
  expect(modelPatched.payload?.entry.providerOverride).toBe("openai");
  expect(modelPatched.payload?.entry.model).toBeUndefined();
  expect(modelPatched.payload?.entry.modelProvider).toBeUndefined();
  expect(modelPatched.payload?.resolved?.modelProvider).toBe("openai");
  expect(modelPatched.payload?.resolved?.model).toBe("gpt-test-a");
  expect(modelPatched.payload?.resolved?.agentRuntime).toEqual({
    id: "openclaw",
    source: "implicit",
  });

  const listAfterModelPatch = await directSessionReq<{
    sessions: Array<{
      key: string;
      modelProvider?: string;
      model?: string;
      agentRuntime?: { id: string; source: string; devicePlacementSupported?: boolean };
    }>;
  }>("sessions.list", {});
  const mainAfterModelPatch = listAfterModelPatch.payload?.sessions.find(
    (session) => session.key === "agent:main:main",
  );
  expect(mainAfterModelPatch?.modelProvider).toBe("openai");
  expect(mainAfterModelPatch?.model).toBe("gpt-test-a");
  expect(mainAfterModelPatch?.agentRuntime?.id).toBe("openclaw");
  expect(mainAfterModelPatch?.agentRuntime?.devicePlacementSupported).toBe(true);

  const compacted = await directSessionReq<{ ok: true; compacted: boolean }>("sessions.compact", {
    key: "agent:main:main",
    maxLines: 3,
  });
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  await expect(
    loadTranscriptRows({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath,
    }),
  ).resolves.toHaveLength(3);

  const deleted = await directSessionReq<{
    archived: string[];
    ok: true;
    deleted: boolean;
  }>("sessions.delete", { key: "agent:main:discord:group:dev" });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(deleted.payload?.archived).toHaveLength(1);
  expect(path.basename(deleted.payload?.archived[0] ?? "")).toMatch(
    /^sess-group\.jsonl\.deleted\./,
  );
  const listAfterDelete = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {});
  expect(listAfterDelete.ok).toBe(true);
  expect(listAfterDelete.payload?.sessions.map((session) => session.key)).not.toContain(
    "agent:main:discord:group:dev",
  );
  await expect(
    loadTranscriptRows({
      sessionId: "sess-group",
      sessionKey: "agent:main:discord:group:dev",
      storePath,
    }),
  ).resolves.toEqual([]);

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

  const badThinking = await directSessionReq("sessions.patch", {
    key: "agent:main:main",
    thinkingLevel: "banana",
  });
  expect(badThinking.ok).toBe(false);
  expect((badThinking.error as { message?: unknown } | undefined)?.message ?? "").toMatch(
    /invalid thinkinglevel/i,
  );
});
