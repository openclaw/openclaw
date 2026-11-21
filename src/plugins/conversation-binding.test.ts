import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  nextEventLoopTurn as flushMicrotasks,
} from "../../test/helpers/promise.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { captureConversationRef } from "../infra/outbound/session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingAdapter,
  SessionBindingBindInput,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
import { drainGlobalSingletonLifecycleState as drainLifecycle } from "../shared/global-singleton.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync as closeState,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  buildPluginBindingApprovalCustomId,
  getCurrentPluginConversationBinding as currentBinding,
  hasShownPluginBindingFallbackNotice,
  markPluginBindingFallbackNoticeShown,
  parsePluginBindingApprovalCustomId,
  requestPluginConversationBinding as requestBinding,
  resolvePluginConversationBindingApproval as resolveApproval,
} from "./conversation-binding.js";
import {
  createDiscordCodexBindRequest,
  createTelegramCodexBindRequest,
} from "./conversation-binding.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import { bindPluginSessionConversation as bindSession } from "./session-conversation-binding.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const tempRoot = makeTrackedTempDir("openclaw-plugin-binding", tempDirs);
const previousStateDir = process.env.OPENCLAW_STATE_DIR;

type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;

const sessionBindingState = (() => {
  const records = new Map<string, SessionBindingRecord>();
  let nextId = 1;

  function toKey(ref: ConversationRef): string {
    return JSON.stringify(captureConversationRef(ref));
  }

  return {
    bind: vi.fn(async (input: SessionBindingBindInput) => {
      input.assertCurrent?.();
      const normalized = captureConversationRef(input.conversation);
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
    unbind: vi.fn(async (input: { bindingId?: string }) => {
      const entry = [...records].find(([, record]) => record.bindingId === input.bindingId);
      if (!entry) {
        return [];
      }
      records.delete(entry[0]);
      return [entry[1]];
    }),
    reset() {
      records.clear();
      nextId = 1;
      for (const mock of [this.bind, this.resolveByConversation, this.unbind]) {
        mock.mockReset();
      }
    },
    setRecord(record: SessionBindingRecord) {
      records.set(toKey(record.conversation), record);
    },
  };
})();

const pluginRuntimeState = vi.hoisted<{ registry: PluginRegistry | null }>(() => ({
  registry: null,
}));

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

type PluginBindingRequestInput = Parameters<typeof requestBinding>[0];
type PluginBindingDecision = Parameters<typeof resolveApproval>[0]["decision"];

const expectExpired = (approvalId: string) =>
  expect(approveBindingRequest(approvalId, "allow-once")).resolves.toEqual({ status: "expired" });
const expectBound = (input: PluginBindingRequestInput) =>
  expect(requestBinding(input)).resolves.toMatchObject({ status: "bound" });

function createAdapter(channel: string, accountId: string): SessionBindingAdapter {
  return {
    channel,
    accountId,
    capabilities: { bindSupported: true, unbindSupported: true, placements: ["current", "child"] },
    bind: sessionBindingState.bind,
    listBySession: () => [],
    resolveByConversation: sessionBindingState.resolveByConversation,
    touch: () => {},
    unbind: sessionBindingState.unbind,
  };
}

afterAll(async () => {
  await closeState();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir == null) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  cleanupTrackedTempDirs(tempDirs);
});

afterEach(async () => {
  await drainLifecycle();
  vi.useRealTimers();
});

async function requestPendingBinding(input: PluginBindingRequestInput) {
  const request = await requestBinding(input);
  assert(request.status === "pending", "expected pending bind request");
  return request;
}

const discordRequest = (id: string, account = "isolated") =>
  createDiscordCodexBindRequest(id, "Bind Codex.", account);
const bindRequest = (id: string, summary = id) => ({
  ...discordRequest(id),
  binding: { summary },
});
const pendingDiscord = (id: string, account = "isolated") =>
  requestPendingBinding(discordRequest(id, account));
const pendingTelegram = (topic: string, root?: string) =>
  requestPendingBinding(
    createTelegramCodexBindRequest(`-10099:topic:${topic}`, topic, "Bind Codex.", root),
  );
const controlUiConversation = {
  channel: "webchat",
  accountId: "default",
  conversationId: "agent:main:adopted",
};
const bindControlUi = (
  data: Record<string, unknown>,
  afterBind?: Parameters<typeof bindSession>[0]["afterBind"],
) =>
  bindSession({
    pluginId: "codex",
    pluginRoot: "/codex",
    sessionKey: controlUiConversation.conversationId,
    binding: { data },
    afterBind,
  });

const approveBindingRequest = (
  approvalId: string,
  decision: PluginBindingDecision,
  senderId = "user-1",
) => resolveApproval({ approvalId, decision, senderId });

function bindingRecord(
  conversation: ConversationRef,
  metadata?: SessionBindingRecord["metadata"],
): SessionBindingRecord {
  return {
    bindingId: "existing",
    targetSessionKey: "agent:main:adopted",
    targetKind: "session",
    conversation,
    status: "active",
    boundAt: 1,
    metadata,
  };
}

function clearPluginBindingApprovalRows(): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const approvalsDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
    executeSqliteQuerySync(db, approvalsDb.deleteFrom("plugin_binding_approvals"));
  });
}

function readPluginBindingApprovalRows() {
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
    await drainLifecycle();
    await closeState();
    closeOpenClawStateDatabaseForTest();
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

  it.each([false, true])(
    "restores Control UI state after publication fails (newer bind: %s)",
    async (newerBind) => {
      const previous = bindingRecord(controlUiConversation, {
        pluginBindingOwner: "plugin",
        pluginId: "codex",
        pluginRoot: "/codex",
      });
      if (!newerBind) {
        sessionBindingState.setRecord(previous);
      }
      const publication = createDeferred();
      const first = bindControlUi({ generation: 1 }, () => publication.promise);
      await vi.waitFor(() => expect(sessionBindingState.bind).toHaveBeenCalledOnce());
      // A concurrent Continue queues behind the failing attempt and its rollback.
      const second = newerBind ? bindControlUi({ generation: 2 }) : undefined;
      publication.reject(new Error("publication failed"));
      await expect(first).rejects.toThrow("publication failed");
      await second;
      expect(sessionBindingState.resolveByConversation(controlUiConversation)).toMatchObject({
        targetSessionKey: previous.targetSessionKey,
        metadata: newerBind ? { data: { generation: 2 } } : previous.metadata,
      });
      expect(sessionBindingState.unbind).toHaveBeenCalledWith(
        expect.objectContaining({
          bindingId: "binding-1",
          reason: "plugin-session-bind-rollback",
          scope: controlUiConversation,
        }),
      );
    },
  );

  it("keeps Telegram bind approval callback_data within Telegram's limit", () => {
    const allowAlways = buildPluginBindingApprovalCustomId("abcdefghijkl", "allow-always");
    for (const decision of ["allow-once", "allow-always", "deny"] as const) {
      expect(
        Buffer.byteLength(buildPluginBindingApprovalCustomId("abcdefghijkl", decision), "utf8"),
      ).toBeLessThanOrEqual(64);
    }
    expect(parsePluginBindingApprovalCustomId(allowAlways)).toEqual({
      approvalId: "abcdefghijkl",
      decision: "allow-always",
    });
  });

  it("fails closed when a pending bind approval reaches its 30-minute deadline", async () => {
    await closeState();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const request = await pendingDiscord("channel:ttl");

    // The deadline check is authoritative even when the event loop has not dispatched the timer.
    vi.setSystemTime(1_000 + 30 * 60_000);
    await expectExpired(request.approvalId);
    expect(sessionBindingState.bind).not.toHaveBeenCalled();
    // Retire storage's independent idle timer before counting approval timers.
    await closeState();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts the oldest pending bind approval after 512 requests", async () => {
    await closeState();
    vi.useFakeTimers();
    const requests = [];
    for (let index = 0; index < 513; index += 1) {
      requests.push(await pendingDiscord(`channel:bounded-${index}`));
    }

    // Pending approvals outlive database actors; count only their owned timers.
    await closeState();
    expect(vi.getTimerCount()).toBe(512);
    const oldest = requests[0];
    const newest = requests[512];
    assert(oldest && newest, "expected bounded pending requests");
    await expectExpired(oldest.approvalId);
    await expect(approveBindingRequest(newest.approvalId, "deny")).resolves.toMatchObject({
      status: "denied",
    });
  });

  it("keeps allow-once approval scoped to its requester and conversation", async () => {
    const firstRequest = await pendingDiscord("channel:1");
    await expect(
      approveBindingRequest(firstRequest.approvalId, "allow-once", "another-user"),
    ).resolves.toEqual({ status: "expired" });
    expect((await approveBindingRequest(firstRequest.approvalId, "allow-once")).status).toBe(
      "approved",
    );
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

    const results = await Promise.all([
      approveBindingRequest(firstRequest.approvalId, "allow-always"),
      approveBindingRequest(secondRequest.approvalId, "allow-always"),
    ]);

    expect(results.map((result) => result.status)).toEqual(["approved", "approved"]);
    expect(readPluginBindingApprovalRows()).toEqual(
      ["default", "work"].map((account_id) => ({
        account_id,
        channel: "discord",
        plugin_id: "codex",
        plugin_root: "/plugins/codex-a",
      })),
    );

    // Concurrent publication must retain both cached grants.
    for (const account of ["default", "work"]) {
      await expectBound(discordRequest(`channel:race-${account}b`, account));
    }
  });

  it("expires pending approvals when their Gateway lifecycle closes", async () => {
    const request = await pendingTelegram("79");

    await drainLifecycle();

    await expectExpired(request.approvalId);
  });

  it("does not share persistent approvals across plugin roots even with the same plugin id", async () => {
    const request = await pendingTelegram("77");
    await approveBindingRequest(request.approvalId, "allow-always");

    await pendingTelegram("78", "/plugins/codex-b");
  });

  it("does not wait for an approved bind callback before returning", async () => {
    const pluginRoot = "/plugins/callback-slow-approve";
    const requestInput = { ...discordRequest("channel:slow-approve"), pluginRoot };
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

  function holdWorkerOperation() {
    const entered = createDeferred();
    const release = createDeferred();
    const original = stateWorker.runOpenClawStateWorkerOperation;
    const spy = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementationOnce(async (context, operation) => {
        const value = await original(context, operation);
        entered.resolve();
        await release.promise;
        return value;
      });
    return { entered, release, spy };
  }

  function holdBindingOperation() {
    const entered = createDeferred();
    const release = createDeferred();
    const original = sessionBindingState.bind.getMockImplementation()!;
    const spy = sessionBindingState.bind.mockImplementationOnce(async (input) => {
      entered.resolve();
      await release.promise;
      return await original(input);
    });
    return { entered, release, spy };
  }

  const observe = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

  async function expectHeld(entered: Promise<void>, observed: Promise<unknown>) {
    expect(await Promise.race([entered.then(() => "held"), observed.then(() => "settled")])).toBe(
      "held",
    );
  }

  it.each(["before-commit", "after-commit"] as const)(
    "preserves binding admission and settlement when authority changes %s",
    async (revokeAt) => {
      const input = bindRequest("channel:owner-check", "original binding");
      const pending = await requestPendingBinding(input);
      const approved = await approveBindingRequest(pending.approvalId, "allow-once");
      assert(approved.status === "approved", "expected approved bind result");
      const original = approved.binding;
      const bind = sessionBindingState.bind.getMockImplementation();
      assert(bind, "expected binding adapter fixture");
      let ownerCurrent = true;
      sessionBindingState.bind.mockImplementationOnce(async (request) => {
        if (revokeAt === "before-commit") {
          ownerCurrent = false;
        }
        const result = await bind(request);
        ownerCurrent = false;
        return result;
      });
      const result = requestBinding({
        ...input,
        binding: { summary: "replacement binding" },
        assertCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      });
      if (revokeAt === "before-commit") {
        await expect(result).rejects.toThrow("Command owner was revoked");
        await expect(currentBinding(input)).resolves.toEqual(original);
      } else {
        await expect(result).resolves.toMatchObject({
          status: "bound",
          binding: { summary: "replacement binding" },
        });
        await expect(currentBinding(input)).resolves.toMatchObject({
          summary: "replacement binding",
        });
      }
    },
  );

  it("keeps the actual approval and reopen flow off the application SQLite thread", async () => {
    await closeState();
    requireNodeSqlite();
    const sql = observeMainThreadSql({ includeClose: true });
    try {
      const pending = await requestPendingBinding(bindRequest("channel:worker"));
      expect((await approveBindingRequest(pending.approvalId, "allow-always")).status).toBe(
        "approved",
      );
      await drainLifecycle();
      await closeState();
      registerSessionBindingAdapter(createAdapter("discord", "isolated"));
      await expectBound(bindRequest("channel:worker-reopen"));
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it.each(["read", "upsert", "decision"] as const)(
    "preserves current ownership and admitted decisions after a held approval %s",
    async (mode) => {
      const input = bindRequest("channel:storage-race", "race");
      const pending = mode !== "read" ? await requestPendingBinding(input) : undefined;
      const { entered, release, spy } = holdWorkerOperation();
      const resolutionParams = {
        approvalId: pending?.approvalId ?? "unused",
        decision: "allow-always" as PluginBindingDecision,
        senderId: "user-1",
      };
      const result = pending ? resolveApproval(resolutionParams) : requestBinding(input);
      const observed = observe<Awaited<typeof result>>(result);
      try {
        await expectHeld(entered.promise, observed);
        if (mode === "decision") {
          resolutionParams.decision = "deny";
        } else {
          sessionBindingState.setRecord(
            bindingRecord(input.conversation, mode === "read" ? { owner: "core" } : undefined),
          );
        }
        release.resolve();
        const outcome = await observed;
        if (mode === "decision") {
          expect(outcome).toMatchObject({
            value: { status: "approved", decision: "allow-always" },
          });
          expect(sessionBindingState.bind).toHaveBeenCalledOnce();
        } else if (mode === "read") {
          expect(outcome).toMatchObject({
            value: { status: "error", message: expect.stringContaining("core routing") },
          });
          await expect(requestBinding(input)).resolves.toEqual({
            status: "error",
            message:
              "This conversation is already bound by core routing and cannot be claimed by a plugin.",
          });
        } else {
          expect(outcome).toMatchObject({
            error: expect.objectContaining({ message: expect.stringContaining("core routing") }),
          });
        }
        if (mode !== "decision") {
          expect(sessionBindingState.bind).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await observed;
        spy.mockRestore();
      }
    },
  );

  it.each(["write", "bind"] as const)(
    "joins an admitted %s before resetting its lifecycle",
    async (stage) => {
      const pending = await requestPendingBinding(bindRequest(`channel:reset-${stage}`));
      const gate = stage === "write" ? holdWorkerOperation() : holdBindingOperation();
      const resolution = approveBindingRequest(
        pending.approvalId,
        stage === "write" ? "allow-always" : "allow-once",
      );
      const observed = observe(resolution);
      let resetting: Promise<void> | undefined;
      try {
        await expectHeld(gate.entered.promise, observed);
        if (stage === "write") {
          await expectExpired(pending.approvalId);
          expect(sessionBindingState.bind).not.toHaveBeenCalled();
        }
        let finished = false;
        resetting = drainLifecycle().then(() => {
          finished = true;
        });
        await flushMicrotasks();
        expect(finished).toBe(false);
        gate.release.resolve();
        if (stage === "bind") {
          expect(await observed).toMatchObject({ value: { status: "approved" } });
        } else {
          expect(await observed).toMatchObject({
            error: expect.objectContaining({
              message: expect.stringContaining("operation closed"),
            }),
          });
        }
        await resetting;
        if (stage === "write") {
          expect(sessionBindingState.bind).not.toHaveBeenCalled();
          gate.spy.mockRestore();
          await closeState();
          registerSessionBindingAdapter(createAdapter("discord", "isolated"));
          await expectBound(bindRequest("channel:after-reset"));
        }
      } finally {
        gate.release.resolve();
        await observed;
        await resetting;
        gate.spy.mockRestore();
      }
    },
  );
});
