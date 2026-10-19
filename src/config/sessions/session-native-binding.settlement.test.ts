import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createNativeSessionCommitFinalizer,
  wrapNativeSessionDeletionMutation,
} from "../../agents/harness/native-session/deletion-participant.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { assertPluginStatePublicationSettled } from "../../plugin-state/plugin-state-publication.js";
import * as execution from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as native from "./session-native-binding.execution.test-support.js";
import { withNativeBindingFixture } from "./session-native-binding.test-support.js";

let delivery: {
  dispatched: number;
  beforeExecution?: () => void;
  afterExecution?: (value: unknown) => void;
};
beforeEach(() => {
  delivery = { dispatched: 0 };
  native.spyAgentExecutions(execution, (worker) => ({
    async execute(command, options) {
      if (command.type === "session.nativeBindings.delete") {
        delivery.beforeExecution?.();
        delivery.dispatched++;
      }
      const result = await worker.execute(command, options);
      if (command.type === "session.nativeBindings.delete") {
        delivery.afterExecution?.(result);
      }
      return result;
    },
  }));
});

afterEach(() => vi.restoreAllMocks());

const observeNativeGrants = (observe: Parameters<typeof native.observeNativeGrants>[1]) =>
  native.observeNativeGrants(admission, observe);

it("releases a binding after refusal before worker dispatch and permits a fresh deletion", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    const [entry, binding] = [fixture.readEntry(), fixture.readBinding()] as const;
    const refused = new Error("synthetic refusal before native binding dispatch");
    let readiness = 0;
    observeNativeGrants((_request, facts) => {
      if (facts.kind === "native-binding-ready") {
        readiness++;
      }
    });
    const rejectDispatch = vi.fn(() => {
      expect(fixture.readBinding()).toMatchObject({
        ...binding,
        lease: { token: expect.any(String), expiresAt: expect.any(Number) },
      });
      throw refused;
    });
    delivery.beforeExecution = rejectDispatch;
    await expect(fixture.remove()).rejects.toBe(refused);
    expect(rejectDispatch).toHaveBeenCalledOnce();
    // No native command entered, so neither A nor its S participant could execute SQL.
    expect([delivery.dispatched, readiness]).toEqual([0, 0]);
    expect([fixture.readEntry(), fixture.readBinding()]).toEqual([entry, binding]);

    delivery.beforeExecution = undefined;
    await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
    expect([delivery.dispatched, readiness]).toEqual([1, 1]);
    expect([fixture.readEntry(), fixture.readBinding()]).toEqual([undefined, undefined]);
  });
});

it("does not finalize native custody from a mismatched actual A receipt", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    const finalized = vi.fn();
    const prepare = fixture.harness.withSessionDeletion;
    assert(prepare);
    fixture.harness.withSessionDeletion = (params, run) =>
      prepare(params, async (mutation) =>
        run(
          wrapNativeSessionDeletionMutation(mutation, {
            assertCurrent: params.assertCurrent,
            committed: finalized,
            rolledBack() {},
          }),
        ),
      );
    let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
    const create = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) => {
        const owned = create((request, grant) => {
          if (
            request.stage === "commit" &&
            native.publication(request)?.kind === "session-native-binding"
          ) {
            nativeAdmission = owned;
          }
          callback(request, grant);
        }, attachment);
        return owned;
      },
    );
    const corrupt = (value: unknown) => {
      assert(
        isRecord(value) && value.kind === "session-native-binding" && value.agent === "committed",
      );
      assert(isRecord(value.receipt) && typeof value.receipt.transferId === "number");
      value.receipt.transferId += 1;
    };
    delivery.afterExecution = (value) => {
      corrupt(value);
      corrupt(nativeAdmission?.committed?.facts);
    };
    await expect(fixture.remove()).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(delivery.dispatched).toBe(1);
    expect([fixture.readEntry(), fixture.readBinding()]).toEqual([undefined, undefined]);
    expect(finalized).not.toHaveBeenCalled();
    const replay = vi.fn(async () => undefined);
    await expect(
      fixture.harness.withSessionDeletion({ ...fixture.scope, assertCurrent() {} }, replay),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(replay).not.toHaveBeenCalled();
  });
});

it("joins a real pending heartbeat after readiness refusal and enters A and S only once", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    const count = { ready: 0, sharedDelete: 0, agentCommit: 0 };
    observeNativeGrants((request, facts) => {
      if (facts.kind === "native-binding-ready" && ++count.ready === 1) {
        // Accept the actual heartbeat immediately before the synchronous readiness decision.
        vi.advanceTimersByTime(21_000);
      }
      if (
        facts.kind === "native-binding-storage" &&
        facts.phase === "delete" &&
        facts.stage === "transaction"
      ) {
        count.sharedDelete++;
      }
      if (request.stage === "commit" && facts.kind === "session-native-binding") {
        count.agentCommit++;
      }
    });
    try {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
      expect(count).toEqual({ ready: 2, sharedDelete: 1, agentCommit: 1 });
      expect(delivery.dispatched).toBe(2);
      expect([fixture.readEntry(), fixture.readBinding()]).toEqual([undefined, undefined]);
    } finally {
      vi.useRealTimers();
    }
  });
});

it.each([
  { checkpoint: "S commit", kind: "agentsapi" },
  { checkpoint: "A commit", kind: "acp" },
] as const)(
  "blocks the original $kind generation after actual worker loss at $checkpoint without replay or compensation",
  async ({ checkpoint, kind }) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const finalized = vi.fn();
      const rolledBack = vi.fn();
      if (kind === "acp") {
        fixture.bindingStore.delete(fixture.bindingKey);
        fixture.harness.withSessionDeletion = (_params, run) =>
          run(createNativeSessionCommitFinalizer({ commit: finalized, rollback: rolledBack }));
      }
      const original = fixture.readEntry();
      assert(original);
      const identity = captureOpenClawStateWorkerContext({ env: fixture.scope.env }).admission
        .identity.key;
      const terminateWorker = native.captureCommandWorker("session.nativeBindings.delete");
      let stopped: Promise<number> | undefined;
      observeNativeGrants((request, facts) => {
        const atCheckpoint =
          checkpoint === "S commit"
            ? facts.kind === "native-binding-storage" &&
              facts.phase === "delete" &&
              facts.stage === "commit"
            : request.stage === "commit" && facts.kind === "session-native-binding";
        if (atCheckpoint && !stopped) {
          stopped = terminateWorker();
          throw new Error("synthetic native worker termination");
        }
      });
      try {
        const deletion = fixture.remove();
        await expect(deletion).rejects.toBeInstanceOf(SqliteWorkerError);
        await expect(deletion).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(() => assertPluginStatePublicationSettled(identity)).toThrow(
          "authority is unavailable",
        );
        assert(stopped, "the test must reach the requested native commit checkpoint");
        await stopped;
        expect(delivery.dispatched).toBe(1);
        expect(fixture.readEntry()).toEqual(original);
        if (checkpoint === "S commit") {
          expect(fixture.readBinding()).toMatchObject({ lease: { token: expect.any(String) } });
        } else {
          expect(fixture.readBinding()).toBeUndefined();
        }
        await expect(fixture.remove()).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(delivery.dispatched).toBe(1);
        expect([finalized.mock.calls, rolledBack.mock.calls]).toEqual([[], []]);
      } finally {
        await stopped;
      }
    });
  },
);
