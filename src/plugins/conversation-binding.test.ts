// Covers plugin conversation binding persistence and lookup behavior.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type {
  ConversationRef,
  SessionBindingAdapter,
  SessionBindingBindInput,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  createDiscordCodexBindRequest,
  createTelegramCodexBindRequest,
} from "./conversation-binding.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const tempRoot = makeTrackedTempDir("openclaw-plugin-binding", tempDirs);
const previousStateDir = process.env.OPENCLAW_STATE_DIR;

type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;

const sessionBindingState = vi.hoisted(() => {
  const records = new Map<string, SessionBindingRecord>();
  let nextId = 1;

  function normalizeRef(ref: ConversationRef): ConversationRef {
    return {
      channel: ref.channel.trim().toLowerCase(),
      accountId: ref.accountId.trim() || "default",
      conversationId: ref.conversationId.trim(),
      parentConversationId: ref.parentConversationId?.trim() || undefined,
    };
  }

  function toKey(ref: ConversationRef): string {
    return JSON.stringify(normalizeRef(ref));
  }

  return {
    bind: vi.fn(async (input: SessionBindingBindInput) => {
      const normalized = normalizeRef(input.conversation);
      const record: SessionBindingRecord = {
        bindingId: `binding-${nextId++}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: normalized,
        status: "active",
        boundAt: Date.now(),
        metadata: input.metadata,
      };
      records.set(toKey(normalized), record);
      return record;
    }),
    resolveByConversation: vi.fn((ref: ConversationRef) => records.get(toKey(ref)) ?? null),
    touch: vi.fn(),
    unbind: vi.fn(async (input: { bindingId?: string }) => {
      const removed: SessionBindingRecord[] = [];
      for (const [key, record] of records.entries()) {
        if (record.bindingId !== input.bindingId) {
          continue;
        }
        removed.push(record);
        records.delete(key);
      }
      return removed;
    }),
    reset() {
      records.clear();
      nextId = 1;
      this.bind.mockClear();
      this.resolveByConversation.mockClear();
      this.touch.mockClear();
      this.unbind.mockClear();
    },
    setRecord(record: SessionBindingRecord) {
      records.set(toKey(record.conversation), record);
    },
  };
});

const pluginRuntimeState = vi.hoisted(
  () =>
    ({
      // The runtime mock is initialized before imports; beforeEach installs the real shared stub.
      registry: null as unknown as PluginRegistry,
    }) satisfies { registry: PluginRegistry },
);

vi.mock("./runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
  return {
    ...actual,
    getActivePluginRegistry: () => pluginRuntimeState.registry,
    getActivePluginChannelRegistry: () => pluginRuntimeState.registry,
    setActivePluginRegistry: (registry: PluginRegistry) => {
      pluginRuntimeState.registry = registry;
    },
  };
});

let buildPluginBindingApprovalCustomId: typeof import("./conversation-binding.js").buildPluginBindingApprovalCustomId;
let bindPluginSessionConversation: typeof import("./session-conversation-binding.js").bindPluginSessionConversation;
let hasShownPluginBindingFallbackNotice: typeof import("./conversation-binding.js").hasShownPluginBindingFallbackNotice;
let markPluginBindingFallbackNoticeShown: typeof import("./conversation-binding.js").markPluginBindingFallbackNoticeShown;
let parsePluginBindingApprovalCustomId: typeof import("./conversation-binding.js").parsePluginBindingApprovalCustomId;
let requestPluginConversationBinding: typeof import("./conversation-binding.js").requestPluginConversationBinding;
let resolvePluginConversationBindingApproval: typeof import("./conversation-binding.js").resolvePluginConversationBindingApproval;
let registerSessionBindingAdapter: typeof import("../infra/outbound/session-binding-service.js").registerSessionBindingAdapter;
let unregisterSessionBindingAdapter: typeof import("../infra/outbound/session-binding-service.js").unregisterSessionBindingAdapter;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;

type PluginBindingRequestInput = Parameters<typeof requestPluginConversationBinding>[0];
type PluginBindingDecision = Parameters<
  typeof resolvePluginConversationBindingApproval
>[0]["decision"];

function createAdapter(channel: string, accountId: string): SessionBindingAdapter {
  return {
    channel,
    accountId,
    capabilities: { bindSupported: true, unbindSupported: true, placements: ["current", "child"] },
    bind: sessionBindingState.bind,
    listBySession: () => [],
    resolveByConversation: sessionBindingState.resolveByConversation,
    touch: sessionBindingState.touch,
    unbind: sessionBindingState.unbind,
  };
}

afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir == null) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  cleanupTrackedTempDirs(tempDirs);
});

beforeAll(async () => {
  ({
    buildPluginBindingApprovalCustomId,
    hasShownPluginBindingFallbackNotice,
    markPluginBindingFallbackNoticeShown,
    parsePluginBindingApprovalCustomId,
    requestPluginConversationBinding,
    resolvePluginConversationBindingApproval,
  } = await import("./conversation-binding.js"));
  ({ bindPluginSessionConversation } = await import("./session-conversation-binding.js"));
  ({ registerSessionBindingAdapter, unregisterSessionBindingAdapter } =
    await import("../infra/outbound/session-binding-service.js"));
  ({ setActivePluginRegistry } = await import("./runtime.js"));
});

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  vi.useRealTimers();
});

async function requestPendingBinding(input: PluginBindingRequestInput) {
  const request = await requestPluginConversationBinding(input);
  expect(request.status).toBe("pending");
  if (request.status !== "pending") {
    throw new Error("expected pending bind request");
  }
  return request;
}

const discordRequest = (id: string, account = "isolated") =>
  createDiscordCodexBindRequest(id, "Bind Codex.", account);
const pendingDiscord = (id: string, account = "isolated") =>
  requestPendingBinding(discordRequest(id, account));

async function approveBindingRequest(approvalId: string, decision: PluginBindingDecision) {
  return await resolvePluginConversationBindingApproval({
    approvalId,
    decision,
    senderId: "user-1",
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function clearPluginBindingApprovalRows(): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const approvalsDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
    executeSqliteQuerySync(db, approvalsDb.deleteFrom("plugin_binding_approvals"));
  });
}

function readPluginBindingApprovalRows(): Array<{
  account_id: string;
  channel: string;
  plugin_id: string;
  plugin_root: string;
}> {
  const { db } = openOpenClawStateDatabase();
  const approvalsDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
  return executeSqliteQuerySync(
    db,
    approvalsDb
      .selectFrom("plugin_binding_approvals")
      .select(["account_id", "channel", "plugin_id", "plugin_root"])
      .orderBy("account_id", "asc")
      .orderBy("plugin_root", "asc"),
  ).rows;
}

describe("plugin conversation binding approvals", () => {
  beforeEach(async () => {
    await drainGlobalSingletonLifecycleState();
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    clearPluginBindingApprovalRows();
    sessionBindingState.reset();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const adapters = [
      createAdapter("discord", "default"),
      createAdapter("discord", "work"),
      createAdapter("discord", "isolated"),
      createAdapter("telegram", "default"),
      createAdapter("webchat", "default"),
    ];
    adapters.forEach(unregisterSessionBindingAdapter);
    adapters.forEach(registerSessionBindingAdapter);
  });

  it("keeps fallback notices independent across channel and account binding owners", () => {
    const bindingId = "default:shared-conversation";
    for (const scope of [
      { channel: "discord", accountId: "default" },
      { channel: "telegram", accountId: "default" },
      { channel: "discord", accountId: "work" },
    ]) {
      expect(hasShownPluginBindingFallbackNotice(bindingId, scope)).toBe(false);
      markPluginBindingFallbackNoticeShown(bindingId, scope);
      expect(hasShownPluginBindingFallbackNotice(bindingId, scope)).toBe(true);
    }
  });

  it("restores the prior Control UI binding when provider publication fails", async () => {
    const previous: SessionBindingRecord = {
      bindingId: "binding-prior",
      targetSessionKey: "agent:main:adopted",
      targetKind: "session",
      conversation: {
        channel: "webchat",
        accountId: "default",
        conversationId: "agent:main:adopted",
      },
      status: "active",
      boundAt: 1,
      metadata: { pluginBindingOwner: "plugin", pluginId: "codex", pluginRoot: "/codex" },
    };
    sessionBindingState.setRecord(previous);

    await expect(
      bindPluginSessionConversation({
        pluginId: "codex",
        pluginRoot: "/codex",
        sessionKey: "agent:main:adopted",
        binding: { data: { kind: "codex-cli-node-session", version: 1 } },
        afterBind: async () => {
          throw new Error("publication failed");
        },
      }),
    ).rejects.toThrow("publication failed");

    expect(sessionBindingState.resolveByConversation(previous.conversation)).toMatchObject({
      targetSessionKey: previous.targetSessionKey,
      metadata: previous.metadata,
    });
    expect(sessionBindingState.bind).toHaveBeenCalledTimes(2);
    expect(sessionBindingState.unbind).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: "binding-1",
        reason: "plugin-session-bind-rollback",
        scope: previous.conversation,
      }),
    );
  });

  it("does not roll back a newer successful Control UI binding", async () => {
    const firstPublication = createDeferred();
    const first = bindPluginSessionConversation({
      pluginId: "codex",
      pluginRoot: "/codex",
      sessionKey: "agent:main:adopted",
      binding: { data: { kind: "remote-runtime", generation: 1 } },
      afterBind: async () => await firstPublication.promise,
    });
    await vi.waitFor(() => expect(sessionBindingState.bind).toHaveBeenCalledOnce());

    // A concurrent Continue for the same session queues behind the failing
    // attempt instead of interleaving with its rollback.
    const second = bindPluginSessionConversation({
      pluginId: "codex",
      pluginRoot: "/codex",
      sessionKey: "agent:main:adopted",
      binding: { data: { kind: "remote-runtime", generation: 2 } },
    });
    firstPublication.reject(new Error("older publication failed"));
    await expect(first).rejects.toThrow("older publication failed");
    await second;

    expect(
      sessionBindingState.resolveByConversation({
        channel: "webchat",
        accountId: "default",
        conversationId: "agent:main:adopted",
      }),
    ).toMatchObject({ metadata: { data: { kind: "remote-runtime", generation: 2 } } });
    // Only the failed attempt rolled back its own binding.
    expect(sessionBindingState.unbind).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "plugin-session-bind-rollback" }),
    );
  });

  it("keeps Telegram bind approval callback_data within Telegram's limit", () => {
    const allowOnce = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-once");
    const allowAlways = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-always");
    const deny = buildPluginBindingApprovalCustomId("abcdefghijkl", "deny");

    expect(Buffer.byteLength(allowOnce, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(allowAlways, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(deny, "utf8")).toBeLessThanOrEqual(64);
    expect(parsePluginBindingApprovalCustomId(allowAlways)).toEqual({
      approvalId: "abcdefghijkl",
      decision: "allow-always",
    });
  });

  it("fails closed when a pending bind approval reaches its 30-minute deadline", async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const request = await pendingDiscord("channel:ttl");

    // The deadline check is authoritative even when the event loop has not dispatched the timer.
    vi.setSystemTime(1_000 + 30 * 60_000);
    await expect(approveBindingRequest(request.approvalId, "allow-once")).resolves.toEqual({
      status: "expired",
    });
    expect(sessionBindingState.bind).not.toHaveBeenCalled();
    // Retire storage's independent idle timer before counting approval timers.
    await closeOpenClawStateDatabaseAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts the oldest pending bind approval after 512 requests", async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.useFakeTimers();
    const requests = [];
    for (let index = 0; index < 513; index += 1) {
      requests.push(await pendingDiscord(`channel:bounded-${index}`));
    }

    // Pending approvals outlive database actors; count only their owned timers.
    await closeOpenClawStateDatabaseAsync();
    expect(vi.getTimerCount()).toBe(512);
    const oldest = requests[0];
    const newest = requests[512];
    if (!oldest || !newest) {
      throw new Error("expected bounded pending requests");
    }
    await expect(approveBindingRequest(oldest.approvalId, "allow-once")).resolves.toEqual({
      status: "expired",
    });
    await expect(approveBindingRequest(newest.approvalId, "deny")).resolves.toMatchObject({
      status: "denied",
    });
  });

  it("keeps allow-once approval scoped to its requester and conversation", async () => {
    const firstRequest = await pendingDiscord("channel:1");
    await expect(
      resolvePluginConversationBindingApproval({
        approvalId: firstRequest.approvalId,
        decision: "allow-once",
        senderId: "another-user",
      }),
    ).resolves.toEqual({ status: "expired" });
    const approved = await approveBindingRequest(firstRequest.approvalId, "allow-once");

    expect(approved.status).toBe("approved");

    await pendingDiscord("channel:2");
  });

  it("does not leak an in-memory auto-approval when persisting an allow-always grant fails", async () => {
    const pendingRequest = await pendingDiscord("channel:persist-fail-1");

    const writeSpy = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockRejectedValueOnce(new Error("approval operation unavailable"));

    await expect(approveBindingRequest(pendingRequest.approvalId, "allow-always")).rejects.toThrow(
      "approval operation unavailable",
    );

    writeSpy.mockRestore();

    expect(readPluginBindingApprovalRows()).toEqual([]);

    // Failed persistence must not leave an in-memory grant.
    await pendingDiscord("channel:persist-fail-2");
  });

  it("persists overlapping always-allow approvals", async () => {
    const firstRequest = await pendingDiscord("channel:race-1", "default");
    const secondRequest = await pendingDiscord("channel:race-2", "work");

    const [firstResult, secondResult] = await Promise.all([
      approveBindingRequest(firstRequest.approvalId, "allow-always"),
      approveBindingRequest(secondRequest.approvalId, "allow-always"),
    ]);

    expect([firstResult.status, secondResult.status]).toEqual(["approved", "approved"]);
    expect(readPluginBindingApprovalRows()).toEqual(
      ["default", "work"].map((account_id) => ({
        account_id,
        channel: "discord",
        plugin_id: "codex",
        plugin_root: "/plugins/codex-a",
      })),
    );

    // Concurrent publication must retain both cached grants.
    const firstFollowUp = await requestPluginConversationBinding(
      discordRequest("channel:race-1b", "default"),
    );
    const secondFollowUp = await requestPluginConversationBinding(
      discordRequest("channel:race-2b", "work"),
    );

    expect([firstFollowUp.status, secondFollowUp.status]).toEqual(["bound", "bound"]);
  });

  it("expires pending approvals when their Gateway lifecycle closes", async () => {
    const request = await requestPendingBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:79",
        "79",
        "Bind this conversation to Codex thread ghi.",
      ),
    );

    await drainGlobalSingletonLifecycleState();

    await expect(approveBindingRequest(request.approvalId, "allow-once")).resolves.toEqual({
      status: "expired",
    });
  });

  it("does not share persistent approvals across plugin roots even with the same plugin id", async () => {
    const request = await requestPendingBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:77",
        "77",
        "Bind this conversation to Codex thread abc.",
      ),
    );
    await approveBindingRequest(request.approvalId, "allow-always");

    await requestPendingBinding(
      createTelegramCodexBindRequest(
        "-10099:topic:78",
        "78",
        "Bind this conversation to Codex thread def.",
        "/plugins/codex-b",
      ),
    );
  });

  it("does not wait for an approved bind callback before returning", async () => {
    const pluginRoot = "/plugins/callback-slow-approve";
    const requestInput = {
      ...createDiscordCodexBindRequest(
        "channel:slow-approve",
        "Bind this conversation to Codex thread slow-approve.",
      ),
      pluginRoot,
    };
    const callbackGate = createDeferred();
    const onResolved = vi.fn(async (_input: unknown) => callbackGate.promise);
    const registry = createEmptyPluginRegistry();
    registry.conversationBindingResolvedHandlers.push({
      pluginId: "codex",
      pluginRoot,
      handler: onResolved,
      source: `${pluginRoot}/index.ts`,
      rootDir: pluginRoot,
    });
    setActivePluginRegistry(registry);
    const request = await requestPendingBinding(requestInput);
    let settled = false;
    const resolution = approveBindingRequest(request.approvalId, "allow-once").then((result) => {
      settled = true;
      return result;
    });
    await flushMicrotasks();
    expect(settled).toBe(true);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0]?.[0]).toMatchObject({
      status: "approved",
      decision: "allow-once",
      binding: {
        pluginId: "codex",
        pluginRoot,
        conversationId: requestInput.conversation.conversationId,
      },
      request: {
        summary: requestInput.binding?.summary,
        detachHint: undefined,
        requestedBySenderId: "user-1",
        conversation: requestInput.conversation,
      },
    });
    callbackGate.resolve();
    expect((await resolution).status).toBe("approved");
  });

  it("refuses to claim a binding without plugin ownership metadata: agent:main:discord:channel:1", async () => {
    const targetSessionKey = "agent:main:discord:channel:1";
    sessionBindingState.setRecord({
      bindingId: "binding-core",
      targetSessionKey,
      targetKind: "session",
      conversation: { channel: "discord", accountId: "default", conversationId: "channel:1" },
      status: "active",
      boundAt: Date.now(),
      metadata: { owner: "core" },
    });
    const result = await requestPluginConversationBinding(discordRequest("channel:1", "default"));
    expect(result).toEqual({
      status: "error",
      message:
        "This conversation is already bound by core routing and cannot be claimed by a plugin.",
    });
    expect(sessionBindingState.bind).not.toHaveBeenCalled();
  });
});
