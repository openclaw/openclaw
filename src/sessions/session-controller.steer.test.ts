import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { QuestionAnswerUnconfirmedError } from "../agents/harness/gateway-question-dispatch.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { MessageInjectionWithdrawnError } from "../auto-reply/reply/message-injection-authority.js";
import type { AgentHarnessAttemptParams } from "../plugin-sdk/agent-harness-runtime.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { controllerGate } from "./controller-core.test-support.js";
import type {
  ReplyBackendHandle,
  ReplyMessageInjectionOptions,
} from "./session-controller.contracts.js";
import {
  abortSessionControllerInput,
  clearSessionControllerMailbox,
  releaseSessionControllerClaim,
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
const acceptedSteer = { status: "accepted", targetRunId: "steer-run" } as const;
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
type Preparation = NonNullable<ReplyMessageInjectionOptions["toolAuthorityPreparation"]>;
type Injection = NonNullable<ReplyBackendHandle["messageInjectionV2"]>;
const acceptQueue: QueueMessage = async ({ onQueueAccepted }) => onQueueAccepted?.(true);
const rejectQueue = async () => {
  throw new Error("backend rejected");
};
const nextTask = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function makeBackend(runId: string, injection: Omit<Injection, "version" | "isAvailable">) {
  return {
    kind: "embedded",
    runId,
    cancel() {},
    messageInjectionV2: { version: 2, isAvailable: () => true, ...injection },
  } satisfies ReplyBackendHandle;
}

function startTurn(
  params: {
    queueMessage?: QueueMessage;
    injection?: "v2" | "legacy";
    compacting?: boolean;
    nativeCommitSupport?: false;
    target?: SessionTarget;
    adapter?: SessionControllerSourceAdapter;
    direct?: boolean;
    turnKind?: "direct";
    replyContract?: Pick<
      ReplyBackendHandle,
      "toolAuthorityFingerprint" | "terminalReplyExpectation"
    >;
  } = {},
) {
  const sessionKey = params.target?.sessionKey ?? key;
  const sessionId = "steer-session";
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
    turnKind: params.turnKind,
    target: params.target,
  });
  operation.setPhase("running");
  const injected: string[] = [];
  const queueMessage = (text: string, options?: Parameters<QueueMessage>[0]) => {
    injected.push(text);
    return params.queueMessage?.(options ?? {}, text) ?? Promise.resolve();
  };
  const backend = {
    kind: "embedded",
    runId: "steer-run",
    cancel() {},
    isCompacting: () => params.compacting === true,
    ...params.replyContract,
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
      abort: () => {},
      supportsTranscriptCommitWait: params.nativeCommitSupport,
    };
    const registration = attachActiveEmbeddedRun(
      sessionId,
      native,
      sessionKey,
      undefined,
      operation.agentId,
      operation,
    );
    cleanups.push(() =>
      detachActiveEmbeddedRun(sessionId, native, undefined, undefined, undefined, registration),
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
  if (params.direct) {
    retireSessionControllerInput(input);
  }
  return { operation, input, injected };
}

function steer(
  input: SessionControllerInput,
  options: ReplyMessageInjectionOptions = { steeringMode: "all" },
  target?: ReturnType<typeof captureCurrentReplyMessageInjectionTarget>,
  text = "steer",
) {
  return submitSessionControllerSteer({ input, text, options, target });
}

function directSteer(
  operation: ReturnType<typeof startTurn>["operation"],
  options: ReplyMessageInjectionOptions = {},
  text = "steer",
) {
  return steerSessionControllerOperation({ operation, text, options });
}
function transcriptOptions(text: string, idempotencyKey: string): ReplyMessageInjectionOptions {
  return {
    userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
      input: { text, idempotencyKey },
      target: () => undefined,
    }),
  };
}

function expectQueued(input: SessionControllerInput) {
  expect(input.phase).toBe("preparing");
  expect(input.retirementRequested).toBeUndefined();
  expect(input.mailbox.entries).toContain(input);
}

function expectNoInput(input: SessionControllerInput) {
  expect(input.mailbox.entries.filter((entry) => entry.phase !== "consumed")).toEqual([]);
}

function preparation(overrides: Partial<Preparation> = {}): Preparation {
  return {
    authorityKind: "run",
    assertCurrent() {},
    compatAssertCurrent() {},
    async prepareCurrent() {},
    ...overrides,
  };
}

function expectRejected(result: ReturnType<typeof steer>, reason: string) {
  return expect(result).resolves.toMatchObject({ status: "rejected", reason });
}

function revocableAuthority(message: string) {
  const error = new Error(message);
  const controller = new AbortController();
  return {
    error,
    revoke: () => controller.abort(error),
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
}

describe("submitSessionControllerSteer", () => {
  it.each([
    [undefined, "required"],
    [undefined, "optional"],
    ["direct", "required"],
    ["direct", "result-required"],
  ] as const)(
    "preserves human input custody with a %s %s reply owner",
    async (turnKind, terminalReplyExpectation) => {
      const fingerprint = "human-reply-contract-tools";
      const { operation, input, injected } = startTurn({
        turnKind,
        queueMessage: acceptQueue,
        replyContract: { toolAuthorityFingerprint: fingerprint, terminalReplyExpectation },
      });
      const result = await steer(input, {
        isInboundUserMessage: true,
        terminalReplyExpectation: "required",
        toolAuthorityFingerprint: fingerprint,
      });

      if (terminalReplyExpectation !== "optional") {
        expect(result).toMatchObject(acceptedSteer);
        await input.settlement.promise;
        expect(input.phase).toBe("consumed");
        expect(injected).toEqual(["steer"]);
        expectNoInput(input);
      } else {
        expect(result).toMatchObject({ status: "rejected", reason: "reply_expectation_mismatch" });
        expect(injected).toEqual([]);
        expectQueued(input);
      }
      expect(operation.result).toBeNull();
    },
  );

  it("preserves the published backend transcript-wait contract without a native capability observation", async () => {
    const received: unknown[] = [];
    const operation: NonNullable<AgentHarnessAttemptParams["replyOperation"]> =
      startTurn().operation;
    operation.attachBackend(
      makeBackend("public-backend", {
        queueMessage: async (text, options, assertCurrent) => {
          assertCurrent();
          received.push({ text, waitForTranscriptCommit: options?.waitForTranscriptCommit });
        },
      }),
    );
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
      const { input, injected } = startTurn({ injection: "legacy" });
      const authority = revocableAuthority("source revoked");
      if (revoked) {
        authority.revoke();
      }
      const result = steer(input, {
        assertCurrent() {
          input.abortSignal.throwIfAborted();
          authority.assertCurrent();
        },
      });

      if (revoked) {
        await expect(result).rejects.toBe(authority.error);
      } else {
        await expectRejected(result, "guarded_injection_unsupported");
        expectQueued(input);
      }
      expect(injected).toEqual([]);
    },
  );

  it.each([
    [false, "accepted"],
    [false, "rejected"],
    [true, "accepted"],
    [true, "rejected"],
  ] as const)("settles a %s direct steer that is %s", async (direct, status) => {
    const { input, operation } = startTurn({
      direct,
      queueMessage: status === "accepted" ? acceptQueue : rejectQueue,
    });
    const result = direct ? directSteer(operation) : steer(input);
    if (status === "accepted") {
      await expect(result).resolves.toEqual({ ...acceptedSteer, result: undefined });
      await input.settlement.promise;
      expect(input.phase).toBe("consumed");
    } else {
      await expectRejected(result, "runtime_rejected");
      if (!direct) {
        expectQueued(input);
      }
    }
    if (direct) {
      expectNoInput(input);
    }
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
      expect(input).toMatchObject({ phase: "injecting", abortSignal: { aborted: false } });
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
      queueMessage: acceptQueue,
    });

    const result = await steer(input);

    expect(result.status).toBe(status);
    if (status === "rejected") {
      expect(result).toMatchObject({ reason: "injection_unavailable" });
      expectQueued(input);
    }
  });

  it.each([false, true])("refuses unsupported transcript waits (direct=%s)", async (direct) => {
    const { operation, input, injected } = startTurn({ direct, nativeCommitSupport: false });
    const accepted: boolean[] = [];
    const options = {
      onQueueAccepted: (value: boolean) => accepted.push(value),
      ...(direct ? { assertCurrent: () => operation.abortSignal.throwIfAborted() } : {}),
    };
    const submit = (wait: boolean) => {
      const request = wait ? { ...options, waitForTranscriptCommit: true } : options;
      return direct ? directSteer(operation, request) : steer(input, request);
    };
    await expectRejected(submit(true), "transcript_commit_wait_unsupported");
    expect(injected).toEqual([]);
    expect(accepted).toEqual([false]);
    if (direct) {
      expectNoInput(input);
      await expect(submit(false)).resolves.toMatchObject({ status: "accepted" });
      expect(injected).toEqual(["steer"]);
      expect(accepted).toEqual([false, true]);
      expectNoInput(input);
    } else {
      expectQueued(input);
    }
  });

  it("keeps released observations stable while a yielded turn refuses captured injection", async () => {
    const { operation, input, injected } = startTurn();
    const target = captureCurrentReplyMessageInjectionTarget(key);
    const released: NonNullable<AgentHarnessAttemptParams["replyOperation"]> = operation;
    const internal = readSessionControllerOperationState(operation);
    expect(findSessionControllerOperationByRunId("steer-run")).toBe(operation);
    expect(findSessionControllerOperationByRunId("other-run")).toBeUndefined();
    expect(operation.yield()).toBe(true);
    expect(operation.yield()).toBe(false);
    expect(internal?.phase).toBe("yielded");
    expect(released).toMatchObject({ phase: "running", result: null, turnKind: "visible" });

    await expectRejected(steer(input, {}, target, "late"), "not_running");
    expect(injected).toEqual([]);
    expectQueued(input);
    operation.complete();
    await released.ownerSettlement;
    expect(released).toMatchObject({ phase: "completed", result: { kind: "completed" } });
    expect(internal?.phase).toBe("yielded");
    expect(findSessionControllerOperationByRunId("steer-run")).toBeUndefined();
  });

  it.each(["stop", "failure"] as const)(
    "preserves %s attribution when it supersedes a native yield",
    async (outcome) => {
      const { operation } = startTurn();
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
      const preparationGate = controllerGate();
      const authority = revocableAuthority("source revoked");
      const { input, operation, injected } = startTurn({
        adapter: { authority },
      });
      const result = steer(input, {
        toolAuthorityPreparation: preparation({
          prepareCurrent: preparationGate.run,
        }),
      });
      const rejected = expect(result).rejects.toThrow(
        disposition === "cancelled" ? "source cancelled" : "source revoked",
      );
      await preparationGate.entered;
      if (disposition === "cancelled") {
        abortSessionControllerInput(input, new Error("source cancelled"));
      } else {
        authority.revoke();
      }
      preparationGate.release();

      await rejected;
      await input.settlement.promise;
      expect(input.phase).toBe("consumed");
      expect(injected).toEqual([]);
      expect(operation.abortSignal.aborted).toBe(false);
    },
  );

  it("does not redirect a captured steer to a replacement backend attempt", async () => {
    const { input, operation } = startTurn();
    const target = captureCurrentReplyMessageInjectionTarget(key);
    let injected = false;
    operation.attachBackend(
      makeBackend("replacement-run", {
        async queueMessage() {
          injected = true;
        },
      }),
    );

    await expectRejected(steer(input, {}, target, "late steer"), "no_active_run");
    expect(injected).toBe(false);
    expectQueued(input);
  });

  it("captures deferred message text and caller policy after preparation under input custody", async () => {
    const { input, operation, injected } = startTurn();
    await operation.bindToolAuthoritySnapshotAsync({
      fingerprint: () => "prepared-policy",
      fingerprintAsync: async () => "prepared-policy",
      project: () => "prepared-policy",
      projectAsync: async () => "prepared-policy",
    });
    await operation.bindToolAuthorityRouteAsync({ provider: "synthetic", model: "test" });
    const options: ReplyMessageInjectionOptions = {
      isInboundUserMessage: true,
      toolAuthorityPreparation: preparation({
        async prepareMessage() {
          expect(input.phase).toBe("injecting");
          options.toolAuthorityOverlay = {
            senderIsOwner: true,
            disableTools: false,
            traceAuthorized: false,
          };
          return "prepared message";
        },
      }),
    };

    await expect(steer(input, options, undefined, "unprepared")).resolves.toMatchObject({
      status: "accepted",
    });
    expect(injected).toEqual(["prepared message"]);
  });
});

describe("steerSessionControllerOperation", () => {
  it("steers only the captured physical owner when logical session keys collide", async () => {
    const sessionKey = "agent:main:controller-steer-physical";
    const physicalTurn = (id: string) =>
      startTurn({
        target: captureSessionTarget({ sessionKey, storeScope: `/synthetic/steer-${id}.sqlite` }),
        direct: true,
      });
    const a = physicalTurn("a");
    const b = physicalTurn("b");

    await expect(directSteer(a.operation, {}, "only a")).resolves.toMatchObject({
      status: "accepted",
    });
    expect(a.injected).toEqual(["only a"]);
    expect(b.injected).toEqual([]);
    expect(b.operation.abortSignal.aborted).toBe(false);
    expect(a.input.mailbox.entries).toEqual([]);
    expect(b.input.mailbox.entries).toEqual([]);
  });

  it("joins duplicate receipts without holding later input behind the first commit", async () => {
    // A native commit can wait on later input, such as the answer to a pending question.
    const commit = createDeferredCore();
    const accepted: string[] = [];
    const { operation, injected } = startTurn({
      direct: true,
      queueMessage: async ({ onQueueAccepted }) => {
        onQueueAccepted?.(true);
        await commit.promise;
      },
    });
    const options = (text: string, caller: string): ReplyMessageInjectionOptions => ({
      ...transcriptOptions(text, text),
      onQueueAccepted: (value) => {
        if (value) {
          accepted.push(caller);
        }
      },
    });

    const first = directSteer(operation, options("first", "original"), "first");
    const duplicate = directSteer(operation, options("first", "duplicate"), "first");
    const second = directSteer(operation, options("second", "unrelated"), "second");
    try {
      // Admission and injection are promise continuations; one macrotask drains them all.
      await nextTask();
      expect(injected).toEqual(["first", "second"]);
      expect(accepted).toEqual(["original", "duplicate", "unrelated"]);
    } finally {
      commit.resolve();
    }

    await expect(Promise.all([first, duplicate, second])).resolves.toMatchObject([
      acceptedSteer,
      acceptedSteer,
      acceptedSteer,
    ]);
  });

  it("retains the receipt when a synchronous backend throws after accepting input", async () => {
    const { operation, input, injected } = startTurn({
      direct: true,
      queueMessage: ({ onQueueAccepted }) => {
        onQueueAccepted?.(true);
        throw new Error("queue notification failed");
      },
    });
    const options = () => transcriptOptions("guidance", "accepted-before-throw");

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(directSteer(operation, options(), "guidance")).resolves.toMatchObject({
        status: "indeterminate",
        targetRunId: "steer-run",
        errorMessage: "queue notification failed",
      });
    }
    expect(injected).toEqual(["guidance"]);
    expectNoInput(input);
  });

  it("fences an async injection when the same backend is attached again before its effect", async () => {
    const gate = controllerGate();
    let injected = false;
    const { operation } = startTurn({ direct: true });
    const backend = makeBackend("reattached-steer", {
      async queueMessage() {
        throw new Error("Expected asynchronous prepared injection");
      },
      async queueMessageAsync(_text, options, authority) {
        await gate.run();
        authority.assertCurrent();
        injected = true;
        options?.onQueueAccepted?.(true);
      },
    });
    operation.attachBackend(backend);
    const result = directSteer(
      operation,
      { toolAuthorityPreparation: preparation() },
      "stale guidance",
    );
    const rejected = expect(result).rejects.toThrow(
      "Message injection authority is no longer current",
    );
    try {
      await gate.entered;
      operation.attachBackend(backend);
    } finally {
      gate.release();
    }
    await rejected;
    expect(injected).toBe(false);
    expect(operation.abortSignal.aborted).toBe(false);
  });

  it("keeps an outcome-only duplicate caller source-bound without leaking its acceptance rejection", async () => {
    const acknowledge = createDeferredCore();
    const commit = createDeferredCore();
    const { injected } = startTurn({
      direct: true,
      queueMessage: async ({ onQueueAccepted }) => {
        await acknowledge.promise;
        onQueueAccepted?.(true);
        await commit.promise;
      },
    });
    const target = captureCurrentReplyMessageInjectionTarget(key);
    if (!target) {
      throw new Error("Expected the running turn's injection target");
    }
    const options = () => transcriptOptions("guidance", "same-guidance");
    const authority = revocableAuthority("duplicate source revoked");
    const first = await beginReplyMessageInjectionTarget(target, "guidance", options());
    const duplicate = await beginReplyMessageInjectionTarget(target, "guidance", {
      ...options(),
      assertCurrent: authority.assertCurrent,
    });
    // Production adoption callers may await only outcome. The other receipt
    // still rejects on revocation and must not become an unhandled rejection.
    const rejected = expect(duplicate.outcome).rejects.toBe(authority.error);
    try {
      authority.revoke();
      acknowledge.resolve();
      await nextTask();
      expect(injected).toEqual(["guidance"]);
    } finally {
      commit.resolve();
    }
    await expect(first.outcome).resolves.toEqual({ status: "accepted" });
    await rejected;
  });

  it("refuses a turn that already settled without reserving input", async () => {
    const { operation, input } = startTurn({ direct: true });
    operation.complete();

    await expect(directSteer(operation, {}, "late")).resolves.toEqual({
      status: "rejected",
      reason: "no_active_run",
    });
    expectNoInput(input);
  });
});

it("returns a proven withdrawn accepted steer to runnable followup custody", async () => {
  const { operation, input } = startTurn({
    queueMessage: async ({ onQueueAccepted }) => {
      onQueueAccepted?.(true);
      throw new MessageInjectionWithdrawnError("exact queued input removed at delivery deadline");
    },
  });
  await expect(steer(input, { waitForTranscriptCommit: true })).resolves.toMatchObject({
    status: "rejected",
    reason: "injection_unavailable",
  });
  operation.complete();
  const claim = expectDefined(tryClaimSessionControllerTask(input), "withdrawn followup claim");
  releaseSessionControllerClaim(claim);
  await claim.settlement.promise;
});
