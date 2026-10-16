import assert from "node:assert/strict";
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
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
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
      await resetState();
      cleanup();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }),
);

async function resetState() {
  await drainGlobalSingletonLifecycleState();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

function createAdapter(): SessionBindingAdapter {
  return {
    channel: "discord",
    accountId: "isolated",
    bind: sessionBindingState.bind,
    listBySession: () => [],
    resolveByConversation: sessionBindingState.resolveByConversation,
  };
}

function bindRequest(conversationId: string, summary = conversationId): PluginBindingRequestInput {
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
  assert(request.status === "pending", "expected pending bind request");
  return request;
}

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

async function approve(approvalId: string, decision: PluginBindingDecision) {
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
    await resetState();
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("conversation-approval-worker-"));
    runOpenClawStateWriteTransaction(() => undefined);
    sessionBindingState = createBindingFixture();
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerSessionBindingAdapter(createAdapter());
  });

  it.each(["before-commit", "after-commit"] as const)(
    "preserves binding admission and settlement when authority changes %s",
    async (revokeAt) => {
      const input = bindRequest("channel:owner-check", "original binding");
      const pending = await requestPendingBinding(input);
      const approved = await approve(pending.approvalId, "allow-once");
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
    requireNodeSqlite();
    const sql = observeMainThreadSql({ includeClose: true });
    try {
      const pending = await requestPendingBinding(bindRequest("channel:worker"));
      expect((await approve(pending.approvalId, "allow-always")).status).toBe("approved");
      await drainGlobalSingletonLifecycleState();
      await closeOpenClawStateDatabaseAsync();
      registerSessionBindingAdapter(createAdapter());
      await expect(
        requestPluginConversationBinding(bindRequest("channel:worker-reopen")),
      ).resolves.toMatchObject({ status: "bound" });
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
      const result = pending
        ? resolvePluginConversationBindingApproval(resolutionParams)
        : requestPluginConversationBinding(input);
      const observed = observe<Awaited<typeof result>>(result);
      try {
        await expectHeld(entered.promise, observed);
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

  it.each(["write", "bind"] as const)(
    "joins an admitted %s before resetting its lifecycle",
    async (stage) => {
      const pending = await requestPendingBinding(bindRequest(`channel:reset-${stage}`));
      const gate = stage === "write" ? holdWorkerOperation() : holdBindingOperation();
      const resolution = approve(
        pending.approvalId,
        stage === "write" ? "allow-always" : "allow-once",
      );
      const observed = observe(resolution);
      let resetting: Promise<void> | undefined;
      try {
        await expectHeld(gate.entered.promise, observed);
        if (stage === "write") {
          expect((await approve(pending.approvalId, "allow-once")).status).toBe("expired");
          expect(sessionBindingState.bind).not.toHaveBeenCalled();
        }
        let finished = false;
        resetting = drainGlobalSingletonLifecycleState().then(() => {
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
          await closeOpenClawStateDatabaseAsync();
          registerSessionBindingAdapter(createAdapter());
          await expect(
            requestPluginConversationBinding(bindRequest("channel:after-reset")),
          ).resolves.toMatchObject({ status: "bound" });
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
