import { afterEach, describe, expect, it } from "vitest";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { QuestionAnswerUnconfirmedError } from "../agents/harness/gateway-question-dispatch.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import type { AgentHarnessAttemptParams } from "../plugin-sdk/agent-harness-runtime.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  ReplyBackendHandle,
  ReplyMessageInjectionOptions,
} from "./session-controller.contracts.js";
import {
  abortSessionControllerInput,
  clearSessionControllerMailbox,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  type SessionControllerInput,
  type SessionControllerSourceAdapter,
} from "./session-controller.mailbox.js";
import {
  beginReplyMessageInjectionTarget,
  captureCurrentReplyMessageInjectionTarget,
} from "./session-controller.message-injection.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { findSessionControllerOperationByRunId } from "./session-controller.queries.js";
import { readSessionControllerOperationState } from "./session-controller.state.js";
import {
  steerSessionControllerOperation,
  submitSessionControllerSteer,
} from "./session-controller.steer.js";
import { captureSessionControllerStop, stopSession } from "./session-controller.stop.js";
import { captureSessionTarget, type SessionTarget } from "./session-controller.target.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";

const key = "agent:main:controller-steer";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

type QueueMessage = (
  options: { onQueueAccepted?: (accepted: boolean) => void },
  text: string,
) => Promise<void>;

/** One running turn whose backend injection behavior is chosen per case. */
function startTurn(params: {
  queueMessage: QueueMessage;
  injection?: "v2" | "legacy";
  compacting?: boolean;
  nativeCommitSupport?: false;
  target?: SessionTarget;
  adapter?: SessionControllerSourceAdapter;
}) {
  const sessionKey = params.target?.sessionKey ?? key;
  const operation = createReplyOperation({
    sessionKey,
    sessionId: "steer-session",
    resetTriggered: false,
    target: params.target,
  });
  operation.setPhase("running");
  const queueMessage = (text: string, options?: Parameters<QueueMessage>[0]) =>
    params.queueMessage(options ?? {}, text);
  const backend = {
    kind: "embedded",
    runId: "steer-run",
    cancel: () => {},
    isCompacting: () => params.compacting === true,
    ...(params.injection === "legacy"
      ? { messageInjection: { isAvailable: () => true, queueMessage } }
      : { messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage } }),
  } satisfies ReplyBackendHandle;
  operation.attachBackend(backend);
  if (params.nativeCommitSupport !== undefined) {
    const native = {
      ...backend,
      queueMessage,
      isStreaming: () => true,
      isCompacting: () => params.compacting === true,
      abort: () => {},
      supportsTranscriptCommitWait: params.nativeCommitSupport,
    };
    const registration = attachActiveEmbeddedRun(
      operation.sessionId,
      native,
      sessionKey,
      undefined,
      operation.agentId,
      operation,
    );
    cleanups.push(() =>
      detachActiveEmbeddedRun(
        operation.sessionId,
        native,
        undefined,
        undefined,
        undefined,
        registration,
      ),
    );
  }
  const input = reserveSessionControllerSource(sessionKey, {
    policy: { mode: "steer" },
    target: params.target,
    adapter: params.adapter,
  });
  cleanups.push(() => {
    operation.complete();
    retireSessionControllerInput(input);
    clearSessionControllerMailbox(input.mailbox, () => {});
  });
  return { operation, input };
}

const steer = (input: SessionControllerInput) =>
  submitSessionControllerSteer({ input, text: "steer", options: { steeringMode: "all" } });

function expectQueued(input: SessionControllerInput) {
  expect(input.phase).toBe("preparing");
  expect(input.retirementRequested).toBeUndefined();
  expect(input.mailbox.entries).toContain(input);
}

describe("submitSessionControllerSteer", () => {
  it("preserves the published backend transcript-wait contract without a native capability observation", async () => {
    const received: unknown[] = [];
    const operation: NonNullable<AgentHarnessAttemptParams["replyOperation"]> = startTurn({
      queueMessage: async () => {},
    }).operation;
    operation.attachBackend({
      kind: "embedded",
      runId: "public-backend",
      cancel() {},
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (text, options, assertCurrent) => {
          assertCurrent();
          received.push({ text, waitForTranscriptCommit: options?.waitForTranscriptCommit });
        },
      },
    });
    const target = captureCurrentReplyMessageInjectionTarget(operation.key)!;
    const attempt = await beginReplyMessageInjectionTarget(target, "published input", {
      waitForTranscriptCommit: true,
    });
    await expect(attempt.acceptance).resolves.toBe(true);
    await expect(attempt.outcome).resolves.toEqual({ status: "accepted" });
    expect(received).toEqual([{ text: "published input", waitForTranscriptCommit: true }]);
  });

  it.each([false, true])(
    "checks source authority before guarded legacy injection (revoked=%s)",
    async (revoked) => {
      let injected = false;
      const { input } = startTurn({
        injection: "legacy",
        queueMessage: async () => {
          injected = true;
        },
      });
      const authorityError = new Error("source revoked");
      const result = submitSessionControllerSteer({
        input,
        text: "steer",
        options: {
          assertCurrent() {
            input.abortSignal.throwIfAborted();
            if (revoked) {
              throw authorityError;
            }
          },
        },
      });

      if (revoked) {
        await expect(result).rejects.toBe(authorityError);
      } else {
        await expect(result).resolves.toMatchObject({
          status: "rejected",
          reason: "guarded_injection_unsupported",
        });
        expectQueued(input);
      }
      expect(injected).toBe(false);
    },
  );

  it("consumes an accepted steer into the captured turn", async () => {
    const { input } = startTurn({
      queueMessage: async ({ onQueueAccepted }) => onQueueAccepted?.(true),
    });

    await expect(steer(input)).resolves.toEqual({
      status: "accepted",
      targetRunId: "steer-run",
      result: undefined,
    });
    await input.settlement.promise;
    expect(input.phase).toBe("consumed");
  });

  it("keeps accepted steering with the active restart owner until its native outcome settles", async () => {
    resetGatewayWorkAdmission();
    const accepted = createDeferredCore();
    const receipt = createDeferredCore();
    const { operation, input } = startTurn({
      queueMessage: ({ onQueueAccepted }) => {
        onQueueAccepted?.(true);
        accepted.resolve();
        return receipt.promise;
      },
    });
    const result = steer(input);
    try {
      await accepted.promise;
      markGatewayRestartDraining();
      expect(input.phase).toBe("injecting");
      expect(input.abortSignal.aborted).toBe(false);
      expect(operation.abortSignal.aborted).toBe(false);

      const outcome = await stopSession({
        source: "restart",
        capture: captureSessionControllerStop({ inputs: [input], operations: [operation] }),
      }).completed;
      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
      expect(isAgentRunRestartAbortReason(input.abortSignal.reason)).toBe(true);
      let settled = false;
      void outcome.settled.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      receipt.resolve();
      await expect(result).resolves.toMatchObject({ status: "accepted" });
      await input.settlement.promise;
      operation.complete();
      await outcome.settled;
      expect(settled).toBe(true);
    } finally {
      receipt.resolve();
      await result;
      resetGatewayWorkAdmission();
    }
  });

  it("leaves a definitely rejected steer queued for its followup", async () => {
    const { input } = startTurn({
      queueMessage: async () => {
        throw new Error("backend rejected");
      },
    });

    await expect(steer(input)).resolves.toMatchObject({
      status: "rejected",
      reason: "runtime_rejected",
    });
    expectQueued(input);
  });

  it("keeps custody of an indeterminate steer and never returns it to the queue", async () => {
    const receipt = createDeferredCore();
    const { input } = startTurn({ queueMessage: () => receipt.promise });

    const result = steer(input);
    await Promise.resolve();
    await Promise.resolve();
    expect(input.phase).toBe("injecting");
    expect(tryClaimSessionControllerTask(input)).toBeUndefined();
    receipt.reject(new QuestionAnswerUnconfirmedError("unknown acceptance"));

    await expect(result).resolves.toMatchObject({ status: "indeterminate" });
    await input.settlement.promise;
    expect(input.phase).toBe("consumed");
  });

  it.each([
    ["v2", "accepted"],
    ["legacy", "rejected"],
  ] as const)("during compaction a %s backend is %s", async (injection, status) => {
    const { input } = startTurn({
      injection,
      compacting: true,
      queueMessage: async ({ onQueueAccepted }) => onQueueAccepted?.(true),
    });

    const result = await steer(input);

    expect(result.status).toBe(status);
    if (status === "rejected") {
      expect(result).toMatchObject({ reason: "injection_unavailable" });
      expectQueued(input);
    }
  });

  it("leaves a transcript-wait steer queued when the backend cannot confirm commits", async () => {
    let injected = false;
    const { input } = startTurn({
      nativeCommitSupport: false,
      queueMessage: async () => {
        injected = true;
      },
    });
    const accepted: boolean[] = [];

    await expect(
      submitSessionControllerSteer({
        input,
        text: "steer",
        options: {
          waitForTranscriptCommit: true,
          onQueueAccepted: (value) => accepted.push(value),
        },
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "transcript_commit_wait_unsupported" });
    expect(injected).toBe(false);
    // The caller's own fallback learns of the refusal through its acceptance callback.
    expect(accepted).toEqual([false]);
    expectQueued(input);
  });

  it("keeps released observations stable while a yielded turn refuses captured injection", async () => {
    let injected = false;
    const { operation, input } = startTurn({
      queueMessage: async () => {
        injected = true;
      },
    });
    const target = captureCurrentReplyMessageInjectionTarget(key);
    const released: NonNullable<AgentHarnessAttemptParams["replyOperation"]> = operation;
    const internal = readSessionControllerOperationState(operation);
    expect(released.phase).toBe("running");
    expect(released.result).toBeNull();

    expect(operation.yield()).toBe(true);
    expect(operation.yield()).toBe(false);
    expect(internal?.phase).toBe("yielded");
    expect(released.phase).toBe("running");
    expect(released.result).toBeNull();
    expect(released.turnKind).toBe("visible");

    await expect(
      submitSessionControllerSteer({ input, target, text: "late", options: {} }),
    ).resolves.toMatchObject({ status: "rejected", reason: "not_running" });
    expect(injected).toBe(false);
    expectQueued(input);
    operation.complete();
    await released.ownerSettlement;
    expect(released).toBe(operation);
    expect(released.phase).toBe("completed");
    expect(released.result).toEqual({ kind: "completed" });
    const completed = released.result;
    expect(released.result).toBe(completed);
    expect(internal?.phase).toBe("yielded");
  });

  it.each(["stop", "failure"] as const)(
    "preserves %s attribution when it supersedes a native yield",
    async (outcome) => {
      const { operation } = startTurn({ queueMessage: async () => {} });
      operation.yield();
      if (outcome === "stop") {
        expect(operation.abortByUser()).toBe(true);
      } else {
        operation.fail("run_failed");
      }
      operation.complete();
      await operation.ownerSettlement;
      expect(operation.result).toMatchObject(
        outcome === "stop"
          ? { kind: "aborted", code: "aborted_by_user" }
          : { kind: "failed", code: "run_failed" },
      );
      expect(operation.phase).toBe(outcome === "stop" ? "aborted" : "failed");
    },
  );

  it.each(["cancelled", "revoked"] as const)(
    "does not inject a %s source after asynchronous policy preparation",
    async (disposition) => {
      const preparing = createDeferredCore();
      const resume = createDeferredCore();
      let current = true;
      let injected = false;
      const { input, operation } = startTurn({
        adapter: {
          authority: {
            assertCurrent() {
              if (!current) {
                throw new Error("source revoked");
              }
            },
          },
        },
        queueMessage: async () => {
          injected = true;
        },
      });
      const result = submitSessionControllerSteer({
        input,
        text: "prepared steer",
        options: {
          toolAuthorityPreparation: {
            authorityKind: "run",
            assertCurrent() {},
            compatAssertCurrent() {},
            async prepareCurrent() {
              preparing.resolve();
              await resume.promise;
            },
          },
        },
      });
      const rejected = expect(result).rejects.toThrow(
        disposition === "cancelled" ? "source cancelled" : "source revoked",
      );
      await preparing.promise;
      if (disposition === "cancelled") {
        abortSessionControllerInput(input, new Error("source cancelled"));
      } else {
        current = false;
      }
      resume.resolve();

      await rejected;
      await input.settlement.promise;
      expect(input.phase).toBe("consumed");
      expect(injected).toBe(false);
      expect(operation.abortSignal.aborted).toBe(false);
    },
  );

  it("does not redirect a captured steer to a replacement backend attempt", async () => {
    const { input, operation } = startTurn({ queueMessage: async () => {} });
    const target = captureCurrentReplyMessageInjectionTarget(key);
    let injected = false;
    operation.attachBackend({
      kind: "embedded",
      runId: "replacement-run",
      cancel() {},
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        async queueMessage() {
          injected = true;
        },
      },
    });

    await expect(
      submitSessionControllerSteer({ input, target, text: "late steer", options: {} }),
    ).resolves.toMatchObject({ status: "rejected", reason: "no_active_run" });
    expect(injected).toBe(false);
    expectQueued(input);
  });

  it("captures deferred message text and caller policy after preparation under input custody", async () => {
    const injected: string[] = [];
    const { input, operation } = startTurn({
      queueMessage: async (_options, text) => {
        injected.push(text);
      },
    });
    await operation.bindToolAuthoritySnapshotAsync({
      fingerprint: () => "prepared-policy",
      fingerprintAsync: async () => "prepared-policy",
      project: () => "prepared-policy",
      projectAsync: async () => "prepared-policy",
    });
    await operation.bindToolAuthorityRouteAsync({ provider: "synthetic", model: "test" });
    const options: ReplyMessageInjectionOptions = {
      isInboundUserMessage: true,
      toolAuthorityPreparation: {
        authorityKind: "run",
        assertCurrent() {},
        compatAssertCurrent() {},
        async prepareCurrent() {},
        async prepareMessage() {
          expect(input.phase).toBe("injecting");
          options.toolAuthorityOverlay = {
            senderIsOwner: true,
            disableTools: false,
            traceAuthorized: false,
          };
          return "prepared message";
        },
      },
    };

    await expect(
      submitSessionControllerSteer({ input, text: "unprepared", options }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(injected).toEqual(["prepared message"]);
  });
});

describe("steerSessionControllerOperation", () => {
  it("retries a refused transcript wait through a fresh direct-operation reservation", async () => {
    const injected: string[] = [];
    const accepted: boolean[] = [];
    const { operation, input } = startTurn({
      nativeCommitSupport: false,
      queueMessage: async (_options, text) => {
        injected.push(text);
      },
    });
    retireSessionControllerInput(input);
    const options = {
      assertCurrent: () => operation.abortSignal.throwIfAborted(),
      onQueueAccepted: (value: boolean) => accepted.push(value),
    };

    await expect(
      steerSessionControllerOperation({
        operation,
        text: "steer",
        options: { ...options, waitForTranscriptCommit: true },
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "transcript_commit_wait_unsupported" });
    expect(injected).toEqual([]);
    expect(accepted).toEqual([false]);
    expect(input.mailbox.entries.filter((entry) => entry.phase !== "consumed")).toEqual([]);

    await expect(
      steerSessionControllerOperation({ operation, text: "steer", options }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(injected).toEqual(["steer"]);
    expect(accepted).toEqual([false, true]);
    expect(input.mailbox.entries.filter((entry) => entry.phase !== "consumed")).toEqual([]);
  });

  it("steers only the captured physical owner when logical session keys collide", async () => {
    const injected: string[] = [];
    const sessionKey = "agent:main:controller-steer-physical";
    const a = startTurn({
      target: captureSessionTarget({ sessionKey, storeScope: "/synthetic/steer-a.sqlite" }),
      queueMessage: async () => {
        injected.push("a");
      },
    });
    const b = startTurn({
      target: captureSessionTarget({ sessionKey, storeScope: "/synthetic/steer-b.sqlite" }),
      queueMessage: async () => {
        injected.push("b");
      },
    });
    retireSessionControllerInput(a.input);
    retireSessionControllerInput(b.input);

    await expect(
      steerSessionControllerOperation({ operation: a.operation, text: "only a", options: {} }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(injected).toEqual(["a"]);
    expect(b.operation.abortSignal.aborted).toBe(false);
    expect(a.input.mailbox.entries).toEqual([]);
    expect(b.input.mailbox.entries).toEqual([]);
  });

  it.each([
    [
      "accepted",
      async ({ onQueueAccepted }: Parameters<QueueMessage>[0]) => onQueueAccepted?.(true),
    ],
    [
      "rejected",
      async () => {
        throw new Error("backend rejected");
      },
    ],
  ] as const)(
    "leaves no input behind when the exact turn's steer is %s",
    async (status, queueMessage) => {
      const { operation, input } = startTurn({ queueMessage });
      retireSessionControllerInput(input);

      await expect(
        steerSessionControllerOperation({ operation, text: "steer", options: {} }),
      ).resolves.toMatchObject({ status });
      expect(input.mailbox.entries.filter((entry) => entry.phase !== "consumed")).toEqual([]);
    },
  );

  it("joins duplicate receipts without holding later input behind the first commit", async () => {
    // A native commit can wait on later input, such as the answer to a pending question.
    const commit = createDeferredCore();
    const injected: string[] = [];
    const accepted: string[] = [];
    const { operation, input } = startTurn({
      queueMessage: async ({ onQueueAccepted }, text) => {
        injected.push(text);
        onQueueAccepted?.(true);
        await commit.promise;
      },
    });
    retireSessionControllerInput(input);
    const options = (text: string, caller: string): ReplyMessageInjectionOptions => ({
      userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
        input: { text, idempotencyKey: text },
        target: () => undefined,
      }),
      onQueueAccepted: (value) => {
        if (value) {
          accepted.push(caller);
        }
      },
    });

    const first = steerSessionControllerOperation({
      operation,
      text: "first",
      options: options("first", "original"),
    });
    const duplicate = steerSessionControllerOperation({
      operation,
      text: "first",
      options: options("first", "duplicate"),
    });
    const second = steerSessionControllerOperation({
      operation,
      text: "second",
      options: options("second", "unrelated"),
    });
    try {
      // Admission and injection are promise continuations; one macrotask drains them all.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(injected).toEqual(["first", "second"]);
      expect(accepted).toEqual(["original", "duplicate", "unrelated"]);
    } finally {
      commit.resolve();
    }

    await expect(Promise.all([first, duplicate, second])).resolves.toMatchObject([
      { status: "accepted", targetRunId: "steer-run" },
      { status: "accepted", targetRunId: "steer-run" },
      { status: "accepted", targetRunId: "steer-run" },
    ]);
  });

  it("retains the receipt when a synchronous backend throws after accepting input", async () => {
    const injected: string[] = [];
    const { operation, input } = startTurn({
      queueMessage: ({ onQueueAccepted }, text) => {
        injected.push(text);
        onQueueAccepted?.(true);
        throw new Error("queue notification failed");
      },
    });
    retireSessionControllerInput(input);
    const options = (): ReplyMessageInjectionOptions => ({
      userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
        input: { text: "guidance", idempotencyKey: "accepted-before-throw" },
        target: () => undefined,
      }),
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        steerSessionControllerOperation({ operation, text: "guidance", options: options() }),
      ).resolves.toMatchObject({
        status: "indeterminate",
        targetRunId: "steer-run",
        errorMessage: "queue notification failed",
      });
    }
    expect(injected).toEqual(["guidance"]);
    expect(input.mailbox.entries.filter((entry) => entry.phase !== "consumed")).toEqual([]);
  });

  it("fences an async injection when the same backend is attached again before its effect", async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let injected = false;
    const { operation, input } = startTurn({ queueMessage: async () => {} });
    retireSessionControllerInput(input);
    const backend: ReplyBackendHandle = {
      kind: "embedded",
      runId: "reattached-steer",
      cancel() {},
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        async queueMessage() {
          throw new Error("Expected asynchronous prepared injection");
        },
        async queueMessageAsync(_text, options, preparation) {
          entered.resolve();
          await resume.promise;
          preparation.assertCurrent();
          injected = true;
          options?.onQueueAccepted?.(true);
        },
      },
    };
    operation.attachBackend(backend);
    const result = steerSessionControllerOperation({
      operation,
      text: "stale guidance",
      options: {
        toolAuthorityPreparation: {
          authorityKind: "run",
          assertCurrent() {},
          compatAssertCurrent() {},
          async prepareCurrent() {},
        },
      },
    });
    const rejected = expect(result).rejects.toThrow(
      "Message injection authority is no longer current",
    );
    try {
      await entered.promise;
      operation.attachBackend(backend);
    } finally {
      resume.resolve();
    }
    await rejected;
    expect(injected).toBe(false);
    expect(operation.abortSignal.aborted).toBe(false);
  });

  it("keeps an outcome-only duplicate caller source-bound without leaking its acceptance rejection", async () => {
    const acknowledge = createDeferredCore();
    const commit = createDeferredCore();
    const injected: string[] = [];
    const { input } = startTurn({
      queueMessage: async ({ onQueueAccepted }, text) => {
        injected.push(text);
        await acknowledge.promise;
        onQueueAccepted?.(true);
        await commit.promise;
      },
    });
    retireSessionControllerInput(input);
    const target = captureCurrentReplyMessageInjectionTarget(key);
    if (!target) {
      throw new Error("Expected the running turn's injection target");
    }
    const options = (): ReplyMessageInjectionOptions => ({
      userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
        input: { text: "guidance", idempotencyKey: "same-guidance" },
        target: () => undefined,
      }),
    });
    let current = true;
    const authorityError = new Error("duplicate source revoked");
    const first = await beginReplyMessageInjectionTarget(target, "guidance", options());
    const duplicate = await beginReplyMessageInjectionTarget(target, "guidance", {
      ...options(),
      assertCurrent() {
        if (!current) {
          throw authorityError;
        }
      },
    });
    // Production adoption callers may await only outcome. The other receipt
    // still rejects on revocation and must not become an unhandled rejection.
    const rejected = expect(duplicate.outcome).rejects.toBe(authorityError);
    try {
      current = false;
      acknowledge.resolve();
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(injected).toEqual(["guidance"]);
    } finally {
      commit.resolve();
    }
    await expect(first.outcome).resolves.toEqual({ status: "accepted" });
    await rejected;
  });

  it("refuses a turn that already settled without reserving input", async () => {
    const { operation, input } = startTurn({ queueMessage: async () => {} });
    retireSessionControllerInput(input);
    operation.complete();

    await expect(
      steerSessionControllerOperation({ operation, text: "late", options: {} }),
    ).resolves.toEqual({ status: "rejected", reason: "no_active_run" });
    expect(input.mailbox.entries.filter((entry) => entry.phase !== "consumed")).toEqual([]);
  });
});

describe("findSessionControllerOperationByRunId", () => {
  it("resolves the slot-owning operation by its backend run ID only while it owns the slot", () => {
    const { operation } = startTurn({ queueMessage: async () => {} });

    expect(findSessionControllerOperationByRunId("steer-run")).toBe(operation);
    expect(findSessionControllerOperationByRunId("other-run")).toBeUndefined();
    operation.complete();
    expect(findSessionControllerOperationByRunId("steer-run")).toBeUndefined();
  });
});
