import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  createEmbeddedRunHandle as createHandle,
  registerTestEmbeddedRun,
  testing as embeddedTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import type {
  ReplyBackendMessageInjectionV2 as Injection,
  ReplyToolAuthorityOverlay as Overlay,
} from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget as beginInjection,
  captureReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { steerSessionControllerOperation } from "../../sessions/session-controller.steer.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { controlRealtimeVoiceAgentRun as controlTalk } from "../../talk/agent-run-control.js";
import { realtimeVoiceControlRuntime as talkRuntime } from "../../talk/agent-run-control.runtime.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  createTestReplyOperation as createOperation,
  queueReplyMessageInjectionTarget as queueTarget,
} from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

const sessionId = "session-1";
const sessionKey = "agent:main:main";
const authority = (senderIsOwner = false, senderId?: string): Overlay => ({
  senderId,
  senderIsOwner,
  disableTools: false,
  traceAuthorized: false,
});
const recorder = (text: string) =>
  createUserTurnTranscriptRecorder({ input: { text }, target: () => undefined });
type Enqueue = (
  text: string,
  check: () => void,
  prepare?: () => Promise<void>,
  options?: Parameters<NonNullable<Injection["queueMessage"]>>[1],
) => Promise<void>;
function makeBackend(
  runId: string,
  toolAuthorityFingerprint: string,
  queue: Enqueue,
  prepared = true,
) {
  const sink: Injection = {
    version: 2,
    isAvailable: () => true,
    queueMessage: (text, options, assertCurrent) => queue(text, assertCurrent, undefined, options),
  };
  if (prepared) {
    sink.queueMessageAsync = (text, options, preparation) =>
      queue(text, preparation.assertCurrent, preparation.prepareCurrent, options);
  }
  return {
    ...createHandle({ runId, toolAuthorityFingerprint }),
    kind: "embedded" as const,
    cancel() {},
    messageInjectionV2: sink,
  };
}

afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  testing.resetSessionControllerForTest();
  vi.useRealTimers();
});

it.each([
  { mode: "steer", revoked: false },
  { mode: "followup", revoked: false },
  { mode: "followup", revoked: true },
] as const)(
  "preserves prepared Talk input for released adapters ($mode, revoked: $revoked)",
  async ({ mode, revoked }) => {
    let current = true;
    let context: string | undefined;
    const createRecorder = vi.fn(recorder);
    const enqueue = vi.fn(
      async (
        queuedSessionId: string,
        _text: string,
        _options: Parameters<NonNullable<Injection["queueMessage"]>>[1],
        canInject: () => boolean,
      ) => {
        expect(canInject()).toBe(true);
        return {
          queued: true as const,
          sessionId: queuedSessionId,
          target: "embedded_run" as const,
          gatewayHealth: "live" as const,
        };
      },
    );
    const result = await controlTalk(
      {
        sessionKey,
        runTarget: {
          runId: "legacy-talk-run",
          signal: new AbortController().signal,
          isCurrent: () => current,
        },
        mode,
        text: "also check the migration",
        getToolAuthorityOverlay: () => ({
          senderIsOwner: true,
          disableTools: false,
          traceAuthorized: false,
        }),
        prepareToolAuthorityOverlay: async () => {
          await Promise.resolve();
          context = "prepared legacy Talk context";
          current = !revoked;
        },
        getSteeringContext: () => context,
        createUserTurnTranscriptRecorder: createRecorder,
      },
      {
        abortEmbeddedAgentRun: () => false,
        queueEmbeddedAgentMessageWithOutcomeAsync: async () => {
          throw new Error("The released adapter must use guarded injection");
        },
        getDiagnosticSessionActivitySnapshot: talkRuntime.getDiagnosticSessionActivitySnapshot,
        resolveActiveEmbeddedRunSessionId: () => sessionId,
        resolveActiveEmbeddedRunOwnerByRunId: () => ({
          runId: "legacy-talk-run",
          sessionId,
          sessionKey,
          abort: () => true,
        }),
        queueGuardedEmbeddedAgentMessageWithOutcomeAsync: enqueue,
      },
    );
    expect(result).toMatchObject({ queued: !revoked, ok: !revoked });
    if (revoked) {
      expect([enqueue.mock.calls, createRecorder.mock.calls]).toEqual([[], []]);
    } else {
      expect(enqueue).toHaveBeenCalledOnce();
      const [, text, options] = enqueue.mock.calls[0]!;
      expect(text).toContain("prepared legacy Talk context\n\nalso check the migration");
      if (mode === "followup") {
        expect(text).toContain("Spoken follow-up for the current voice call.");
      }
      expect(options?.userTurnTranscriptRecorder?.message).toMatchObject({
        role: "user",
        content: text,
      });
      expect(createRecorder).toHaveBeenCalledExactlyOnceWith(text);
    }
  },
);

it("requires a fresh target to use a replacement backend on the same operation", async () => {
  const operation = createOperation({ originatingLeafEntryId: "leaf-a" });
  operation.setPhase("running");
  const firstQueue = vi.fn(async () => {});
  const legacyBackend = (queueMessage: typeof firstQueue) => ({
    kind: "embedded" as const,
    runId: "run-a",
    cancel: vi.fn(),
    messageInjection: { isAvailable: () => true, queueMessage },
  });
  operation.attachBackend(legacyBackend(firstQueue));
  const target = captureReplyMessageInjectionTarget(operation)!;
  const replacementQueue = vi.fn(async () => {});
  operation.attachBackend(legacyBackend(replacementQueue));

  await expect(queueTarget(target, "must not move")).resolves.toEqual({
    status: "rejected",
    reason: "no_active_run",
  });
  expect([firstQueue.mock.calls, replacementQueue.mock.calls]).toEqual([[], []]);

  const fresh = captureReplyMessageInjectionTarget(operation)!;
  await expect(queueTarget(fresh, "replacement")).resolves.toEqual({
    status: "accepted",
  });
  expect(replacementQueue).toHaveBeenCalledWith(
    "replacement",
    expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
  );
});

it.each([
  { first: "gateway", second: "gateway", transition: "deliver" },
  { first: "controller", second: "controller", transition: "deliver" },
  { first: "gateway", second: "controller", transition: "deliver" },
  { first: "controller", second: "gateway", transition: "deliver" },
  { first: "gateway", second: "controller", transition: "refuse" },
  { first: "controller", second: "gateway", transition: "replace" },
  { first: "talk", second: "gateway", transition: "deliver" },
  { first: "talk", second: "talk", transition: "deliver" },
] as const)(
  "orders $first then $second preparation through invocation, before delivery ($transition)",
  async ({ first, second, transition }) => {
    vi.useFakeTimers();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const delivered = createDeferredCore();
    const calls: string[] = [];
    const recorded: string[] = [];
    const pending: Promise<unknown>[] = [];
    const operation = createOperation();
    await operation.bindToolAuthoritySnapshotAsync({
      fingerprint: () => "authority",
      project: () => "authority",
      projectAsync: async (overlay) => {
        if (overlay.senderId === "first") {
          entered.resolve();
          await release.promise;
          if (transition === "refuse") {
            throw new Error("first policy refused");
          }
        }
        return "authority";
      },
    });
    await operation.bindToolAuthorityRouteAsync({ provider: "test", model: "test" });
    const install = (runId: string) => {
      const handle = makeBackend(runId, "authority", (text, assertCurrent, _prepare, options) => {
        assertCurrent();
        calls.push(text);
        options?.onQueueAccepted?.(true);
        return delivered.promise;
      });
      registerTestEmbeddedRun(sessionId, handle, sessionKey, undefined, undefined, operation);
    };
    install("original-run");
    operation.setPhase("running");
    const send = (surface: "gateway" | "controller" | "talk", text: string) => {
      const overlay = authority(true, text);
      const options = { isInboundUserMessage: true, toolAuthorityOverlay: overlay };
      const target = captureReplyMessageInjectionTarget(operation)!;
      let steeringContext: string | undefined;
      const result =
        surface === "gateway"
          ? beginInjection(target, text, options).then((attempt) => attempt.outcome)
          : surface === "controller"
            ? steerSessionControllerOperation({ operation, text, options })
            : controlTalk({
                sessionKey,
                runTarget: {
                  runId: target.runId!,
                  signal: operation.abortSignal,
                  isCurrent: () =>
                    talkRuntime.resolveSourceRunOwner(target.runId!, operation.abortSignal)
                      ?.sessionId === sessionId,
                },
                mode: "steer",
                text,
                getToolAuthorityOverlay: () => overlay,
                prepareToolAuthorityOverlay: async (current) => {
                  await operation.projectToolAuthorityFingerprintAsync(current);
                  steeringContext = "prepared Talk context";
                },
                getSteeringContext: () => steeringContext,
                createUserTurnTranscriptRecorder: (preparedText) => {
                  recorded.push(preparedText);
                  return recorder(preparedText);
                },
              });
      pending.push(result);
      return result;
    };
    try {
      const firstResult = send(first, "first");
      await awaitGateBeforeSettlement(entered.promise, firstResult, "first projection not entered");
      void send(second, "second");
      await vi.advanceTimersByTimeAsync(0);
      expect([calls, recorded]).toEqual([[], []]);
      if (transition === "replace") {
        install("successor-run");
        void send("gateway", "successor");
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual(["successor"]);
      }
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(
        transition === "replace"
          ? ["successor"]
          : transition === "refuse"
            ? ["second"]
            : [
                first === "talk" ? "prepared Talk context\n\nfirst" : "first",
                second === "talk" ? "prepared Talk context\n\nsecond" : "second",
              ],
      );
      expect(recorded).toEqual(calls.filter((text) => text.startsWith("prepared Talk context")));
    } finally {
      release.resolve();
      delivered.resolve();
      await Promise.allSettled(pending);
      operation.complete();
    }
  },
);

it("classifies refused caller policy projection as an authority mismatch before backend invocation", async () => {
  const refusedSessionId = "refused-projection";
  const refusedSessionKey = "agent:main:refused-projection";
  const operation = createOperation({ sessionId: refusedSessionId, sessionKey: refusedSessionKey });
  const projectAsync = vi.fn(async () => {
    throw new Error("caller policy differs");
  });
  await operation.bindToolAuthoritySnapshotAsync({
    fingerprint: () => "creator",
    fingerprintAsync: async () => "creator",
    project: () => {
      throw new Error("caller policy differs");
    },
    projectAsync,
  });
  await operation.bindToolAuthorityRouteAsync({ provider: "test", model: "test" });
  const queueMessage = vi.fn(async () => {});
  const handle = {
    ...createHandle({ runId: "refused-run", toolAuthorityFingerprint: "creator" }),
    messageInjectionV2: {
      version: 2 as const,
      isAvailable: () => true,
      queueMessage,
      queueMessageAsync: queueMessage,
    },
  };
  registerTestEmbeddedRun(
    refusedSessionId,
    handle,
    refusedSessionKey,
    undefined,
    undefined,
    operation,
  );
  operation.setPhase("running");
  await expect(
    steerSessionControllerOperation({
      operation,
      text: "refused",
      options: {
        isInboundUserMessage: true,
        toolAuthorityOverlay: {
          senderIsOwner: false,
          disableTools: false,
          traceAuthorized: false,
        },
      },
    }),
  ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
  expect(projectAsync).toHaveBeenCalled();
  expect(queueMessage).not.toHaveBeenCalled();
});

it.each([
  { backend: "legacy", revoked: false, acceptBeforeRevocation: false },
  { backend: "legacy", revoked: true, acceptBeforeRevocation: false },
  { backend: "prepared", revoked: false, acceptBeforeRevocation: false },
  { backend: "prepared", revoked: true, acceptBeforeRevocation: false },
  { backend: "legacy", revoked: true, acceptBeforeRevocation: true },
  { backend: "prepared", revoked: true, acceptBeforeRevocation: true },
] as const)(
  "refreshes Talk caller policy before $backend enqueue (revoked: $revoked, accepted: $acceptBeforeRevocation)",
  async ({ backend, revoked, acceptBeforeRevocation }) => {
    const talkSessionId = `talk-policy-${backend}-${revoked}`;
    const talkSessionKey = `agent:main:${talkSessionId}`;
    const run = createQueueTestRun({ prompt: "preserve this Talk input" });
    Object.assign(run.run, {
      agentId: "main",
      sessionId: talkSessionId,
      sessionKey: talkSessionKey,
      messageProvider: "telegram",
      senderId: "talk-requester",
    });
    const operation = createOperation({ sessionId: talkSessionId, sessionKey: talkSessionKey });
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
    const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const enqueue = vi.fn();
    const waitForCaller = async () => {
      entered.resolve();
      await resume.promise;
    };
    const injection: Injection = {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, options, assertCurrent) => {
        if (acceptBeforeRevocation) {
          assertCurrent();
          enqueue(text);
          options?.onQueueAccepted?.(true);
        }
        await waitForCaller();
        assertCurrent();
        if (!acceptBeforeRevocation) {
          enqueue(text);
        }
      },
      ...(backend === "prepared"
        ? {
            queueMessageAsync: (async (text, options, preparation) => {
              if (acceptBeforeRevocation) {
                await preparation.prepareCurrent();
                preparation.assertCurrent();
                enqueue(text);
                options?.onQueueAccepted?.(true);
              }
              await waitForCaller();
              await preparation.prepareCurrent();
              preparation.assertCurrent();
              if (!acceptBeforeRevocation) {
                enqueue(text);
              }
            }) satisfies NonNullable<Injection["queueMessageAsync"]>,
          }
        : {}),
    };
    const handle = {
      ...createHandle({ runId: talkSessionId, toolAuthorityFingerprint: fingerprint }),
      kind: "embedded" as const,
      cancel() {},
      messageInjectionV2: injection,
    };
    registerTestEmbeddedRun(talkSessionId, handle, talkSessionKey, undefined, undefined, operation);
    operation.setPhase("running");
    let overlay: Overlay = {
      messageProvider: "telegram",
      senderId: "talk-requester",
      senderIsOwner: false,
      disableTools: false,
      traceAuthorized: false,
    };
    const outcome = controlTalk({
      sessionKey: talkSessionKey,
      mode: "steer",
      text: run.prompt,
      getToolAuthorityOverlay: () => overlay,
    });
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        outcome,
        "Talk did not reach backend preparation",
      );
      if (revoked) {
        overlay = { ...overlay, disableTools: true };
      }
      resume.resolve();
      await expect(outcome).resolves.toMatchObject({
        queued: !revoked || acceptBeforeRevocation,
        ...(acceptBeforeRevocation ? { ok: false, reason: "delivery_unconfirmed" } : {}),
      });
      if (revoked && !acceptBeforeRevocation) {
        expect(enqueue).not.toHaveBeenCalled();
      } else {
        expect(enqueue).toHaveBeenCalledExactlyOnceWith(run.prompt);
      }
    } finally {
      resume.resolve();
      await outcome;
      operation.complete();
    }
  },
);
