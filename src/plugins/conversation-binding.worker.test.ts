import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
  resolvePluginConversationBindingApproval,
} from "./conversation-binding.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { setActivePluginRegistry } from "./runtime.js";

type PluginBindingRequestInput = Parameters<typeof requestPluginConversationBinding>[0];
type PluginBindingDecision = Parameters<
  typeof resolvePluginConversationBindingApproval
>[0]["decision"];

function createBindingFixture() {
  const records = new Map<string, SessionBindingRecord>();
  return {
    bind: vi.fn(async (input: SessionBindingBindInput): Promise<SessionBindingRecord> => {
      input.assertCurrent?.();
      const record: SessionBindingRecord = {
        bindingId: `binding-${records.size + 1}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        metadata: input.metadata,
        status: "active",
        boundAt: 1,
      };
      records.set(input.conversation.conversationId, record);
      return record;
    }),
    setRecord: (record: SessionBindingRecord) =>
      records.set(record.conversation.conversationId, record),
    resolveByConversation: (ref: { conversationId: string }) =>
      records.get(ref.conversationId) ?? null,
  };
}

let sessionBindingState: ReturnType<typeof createBindingFixture>;
const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await drainGlobalSingletonLifecycleState();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }),
);

function createAdapter(channel: string, accountId: string): SessionBindingAdapter {
  return {
    channel,
    accountId,
    bind: sessionBindingState.bind,
    listBySession: () => [],
    resolveByConversation: sessionBindingState.resolveByConversation,
  };
}

function createDiscordCodexBindRequest(
  conversationId: string,
  summary: string,
): PluginBindingRequestInput {
  return {
    pluginId: "fixture-plugin",
    pluginName: "Fixture Plugin",
    pluginRoot: "/plugins/fixture-plugin",
    requestedBySenderId: "user-1",
    conversation: { channel: "discord", accountId: "isolated", conversationId },
    binding: { summary },
  };
}

async function requestPendingBinding(input: PluginBindingRequestInput) {
  const request = await requestPluginConversationBinding(input);
  expect(request.status).toBe("pending");
  if (request.status !== "pending") {
    throw new Error("expected pending bind request");
  }
  return request;
}

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

describe("plugin conversation approval worker lifetime", () => {
  beforeEach(async () => {
    await drainGlobalSingletonLifecycleState();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("conversation-approval-worker-"));
    runOpenClawStateWriteTransaction(() => undefined);
    sessionBindingState = createBindingFixture();
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerSessionBindingAdapter(createAdapter("discord", "isolated"));
  });

  it.each(["before-commit", "after-commit"] as const)(
    "preserves binding admission and settlement when authority changes %s",
    async (revokeAt) => {
      const input = createDiscordCodexBindRequest("channel:owner-check", "original binding");
      const pending = await requestPendingBinding(input);
      const approved = await approveBindingRequest(pending.approvalId, "allow-once");
      expect(approved.status).toBe("approved");
      if (approved.status !== "approved") {
        throw new Error("expected approved bind result");
      }
      const original = approved.binding;
      const bind = sessionBindingState.bind.getMockImplementation();
      if (!bind) {
        throw new Error("expected binding adapter fixture");
      }
      let ownerCurrent = true;
      sessionBindingState.bind.mockImplementationOnce(async (request) => {
        if (revokeAt === "before-commit") {
          ownerCurrent = false;
        }
        const result = await bind(request);
        ownerCurrent = false;
        return result;
      });
      const result = requestPluginConversationBinding({
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
        await expect(getCurrentPluginConversationBinding(input)).resolves.toEqual(original);
      } else {
        await expect(result).resolves.toMatchObject({
          status: "bound",
          binding: { summary: "replacement binding" },
        });
        await expect(getCurrentPluginConversationBinding(input)).resolves.toMatchObject({
          summary: "replacement binding",
        });
      }
    },
  );

  it("keeps the actual approval and reopen flow off the application SQLite thread", async () => {
    await closeOpenClawStateDatabaseAsync();
    const native = requireNodeSqlite();
    const counters = [
      ...(["prepare", "exec", "close"] as const).map((method) =>
        vi.spyOn(native.DatabaseSync.prototype, method),
      ),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(native.StatementSync.prototype, method),
      ),
    ];
    try {
      const pending = await requestPendingBinding(
        createDiscordCodexBindRequest("channel:worker", "worker proof"),
      );
      expect((await approveBindingRequest(pending.approvalId, "allow-always")).status).toBe(
        "approved",
      );
      await drainGlobalSingletonLifecycleState();
      await closeOpenClawStateDatabaseAsync();
      registerSessionBindingAdapter(createAdapter("discord", "isolated"));
      expect(
        (
          await requestPluginConversationBinding(
            createDiscordCodexBindRequest("channel:worker-reopen", "reopen"),
          )
        ).status,
      ).toBe("bound");
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    } finally {
      counters.forEach((counter) => counter.mockRestore());
    }
  });

  it.each(["read", "upsert", "decision"] as const)(
    "preserves current ownership and admitted decisions after a held approval %s",
    async (mode) => {
      const input = createDiscordCodexBindRequest("channel:storage-race", "race");
      const pending = mode !== "read" ? await requestPendingBinding(input) : undefined;
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
      const resolutionParams = {
        approvalId: pending?.approvalId ?? "unused",
        decision: "allow-always" as PluginBindingDecision,
        senderId: "user-1",
      };
      const result = pending
        ? resolvePluginConversationBindingApproval(resolutionParams)
        : requestPluginConversationBinding(input);
      const observed = result.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(
          await Promise.race([entered.promise.then(() => "held"), observed.then(() => "settled")]),
        ).toBe("held");
        if (mode === "decision") {
          resolutionParams.decision = "deny";
        } else {
          sessionBindingState.setRecord({
            bindingId: "foreign",
            targetSessionKey: "agent:main:foreign",
            targetKind: "session",
            conversation: input.conversation,
            status: "active",
            boundAt: 1,
          });
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

  it("joins a consumed approval and cache publication before resetting its lifecycle", async () => {
    const pending = await requestPendingBinding(
      createDiscordCodexBindRequest("channel:reset-write", "reset"),
    );
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
    const resolution = approveBindingRequest(pending.approvalId, "allow-always");
    const observed = resolution.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let resetting: Promise<void> | undefined;
    try {
      expect(
        await Promise.race([entered.promise.then(() => "held"), observed.then(() => "settled")]),
      ).toBe("held");
      expect((await approveBindingRequest(pending.approvalId, "allow-once")).status).toBe(
        "expired",
      );
      expect(sessionBindingState.bind).not.toHaveBeenCalled();
      let resetFinished = false;
      resetting = drainGlobalSingletonLifecycleState().then(() => {
        resetFinished = true;
      });
      await flushMicrotasks();
      expect(resetFinished).toBe(false);
      release.resolve();
      expect(await observed).toMatchObject({
        error: expect.objectContaining({ message: expect.stringContaining("operation closed") }),
      });
      await resetting;
      expect(sessionBindingState.bind).not.toHaveBeenCalled();
      spy.mockRestore();
      await closeOpenClawStateDatabaseAsync();
      registerSessionBindingAdapter(createAdapter("discord", "isolated"));
      expect(
        (
          await requestPluginConversationBinding(
            createDiscordCodexBindRequest("channel:after-reset", "after"),
          )
        ).status,
      ).toBe("bound");
    } finally {
      release.resolve();
      await observed;
      await resetting;
      spy.mockRestore();
    }
  });

  it("retains an already started binding until lifecycle reset can finish", async () => {
    const pending = await requestPendingBinding(
      createDiscordCodexBindRequest("channel:reset-bind", "reset binding"),
    );
    const entered = createDeferred();
    const release = createDeferred();
    const original = sessionBindingState.bind.getMockImplementation()!;
    sessionBindingState.bind.mockImplementationOnce(async (input) => {
      entered.resolve();
      await release.promise;
      return await original(input);
    });
    const resolution = approveBindingRequest(pending.approvalId, "allow-once");
    let resetting: Promise<void> | undefined;
    try {
      await entered.promise;
      let finished = false;
      resetting = drainGlobalSingletonLifecycleState().then(() => {
        finished = true;
      });
      await flushMicrotasks();
      expect(finished).toBe(false);
      release.resolve();
      expect((await resolution).status).toBe("approved");
      await resetting;
    } finally {
      release.resolve();
      await resolution;
      await resetting;
    }
  });
});
