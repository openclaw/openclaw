import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { realtimeVoiceControlRuntime } from "../../talk/agent-run-control.runtime.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyToolAuthorityOverlay,
} from "./reply-run-registry.contracts.js";
import { beginReplyMessageInjectionTarget, replyRunRegistry } from "./reply-run-registry.js";
import {
  createTestReplyOperation,
  queueReplyMessageInjectionTarget,
} from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  testing.resetReplyRunRegistry();
  vi.useRealTimers();
});

it.each([
  { mode: "steer", revoked: false },
  { mode: "followup", revoked: false },
  { mode: "followup", revoked: true },
] as const)(
  "preserves prepared Talk input for released adapters ($mode, revoked: $revoked)",
  async ({ mode, revoked }) => {
    const sessionId = "legacy-talk-session";
    const sessionKey = "agent:main:legacy-talk";
    let current = true;
    let context: string | undefined;
    const createRecorder = vi.fn((text: string) =>
      createUserTurnTranscriptRecorder({ input: { text }, target: () => undefined }),
    );
    const enqueue = vi.fn(
      async (
        queuedSessionId: string,
        _text: string,
        _options: Parameters<typeof queueEmbeddedAgentMessageWithOutcomeAsync>[2],
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
    const result = await controlRealtimeVoiceAgentRun(
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
        ...realtimeVoiceControlRuntime,
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
      expect(enqueue).not.toHaveBeenCalled();
      expect(createRecorder).not.toHaveBeenCalled();
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
  const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
  operation.setPhase("running");
  const firstQueue = vi.fn(async () => {});
  const first = {
    kind: "embedded" as const,
    runId: "run-a",
    cancel: vi.fn(),
    messageInjection: { isAvailable: () => true, queueMessage: firstQueue },
  };
  operation.attachBackend(first);
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
  const replacementQueue = vi.fn(async () => {});
  operation.attachBackend({
    kind: "embedded",
    runId: "run-a",
    cancel: vi.fn(),
    messageInjection: { isAvailable: () => true, queueMessage: replacementQueue },
  });

  await expect(queueReplyMessageInjectionTarget(target, "must not move")).resolves.toEqual({
    status: "rejected",
    reason: "no_active_run",
  });
  expect(firstQueue).not.toHaveBeenCalled();
  expect(replacementQueue).not.toHaveBeenCalled();

  const replacementTarget = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
  await expect(queueReplyMessageInjectionTarget(replacementTarget, "replacement")).resolves.toEqual(
    {
      status: "accepted",
    },
  );
  expect(replacementQueue).toHaveBeenCalledWith(
    "replacement",
    expect.objectContaining({ onQueueAccepted: expect.any(Function) }),
  );
});

it.each([
  { first: "gateway", second: "gateway", transition: "deliver" },
  { first: "embedded", second: "embedded", transition: "deliver" },
  { first: "gateway", second: "embedded", transition: "deliver" },
  { first: "embedded", second: "gateway", transition: "deliver" },
  { first: "gateway", second: "embedded", transition: "refuse" },
  { first: "embedded", second: "gateway", transition: "replace" },
  { first: "talk", second: "gateway", transition: "deliver" },
  { first: "talk", second: "talk", transition: "deliver" },
] as const)(
  "orders $first then $second preparation through invocation, before delivery ($transition)",
  async ({ first, second, transition }) => {
    vi.useFakeTimers();
    const sessionId = "ordered-session";
    const sessionKey = "agent:main:ordered-injection";
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const delivered = createDeferredCore();
    const calls: string[] = [];
    const recordedTexts: string[] = [];
    const pending: Promise<unknown>[] = [];
    const operation = createTestReplyOperation({ sessionKey, sessionId });
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
    const createHandle = (runId: string) => {
      const injection: ReplyBackendMessageInjectionV2 = {
        version: 2,
        isAvailable: () => true,
        queueMessage: (text, _options, assertCurrent) => {
          assertCurrent();
          calls.push(text);
          return delivered.promise;
        },
        queueMessageAsync: (text, _options, preparation) => {
          preparation.assertCurrent();
          calls.push(text);
          return delivered.promise;
        },
      };
      return {
        ...createEmbeddedRunHandle({ runId, toolAuthorityFingerprint: "authority" }),
        kind: "embedded" as const,
        cancel: () => {},
        messageInjectionV2: injection,
      };
    };
    const install = (runId: string) => {
      const handle = createHandle(runId);
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      operation.attachBackend(handle);
    };
    install("original-run");
    operation.setPhase("running");
    const send = (surface: "gateway" | "embedded" | "talk", text: string) => {
      const overlay: ReplyToolAuthorityOverlay = {
        senderId: text,
        senderIsOwner: true,
        disableTools: false,
        traceAuthorized: false,
      };
      const options = { isInboundUserMessage: true, toolAuthorityOverlay: overlay };
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!;
      let steeringContext: string | undefined;
      const result =
        surface === "gateway"
          ? beginReplyMessageInjectionTarget(target, text, options).then(
              (attempt) => attempt.outcome,
            )
          : surface === "embedded"
            ? queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, text, options)
            : controlRealtimeVoiceAgentRun({
                sessionKey,
                runTarget: {
                  runId: target.runId!,
                  signal: operation.abortSignal,
                  isCurrent: () =>
                    realtimeVoiceControlRuntime.resolveActiveEmbeddedRunOwnerByRunId(target.runId!)
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
                  recordedTexts.push(preparedText);
                  return createUserTurnTranscriptRecorder({
                    input: { text: preparedText },
                    target: () => undefined,
                  });
                },
              });
      pending.push(result);
      return result;
    };
    try {
      const firstResult = send(first, "first");
      await awaitGateBeforeSettlement(
        entered.promise,
        firstResult,
        "first injection never reached projection",
      );
      void send(second, "second");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual([]);
      expect(recordedTexts).toEqual([]);
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
      expect(recordedTexts).toEqual(
        calls.filter((text) => text.startsWith("prepared Talk context")),
      );
    } finally {
      release.resolve();
      delivered.resolve();
      await Promise.allSettled(pending);
      operation.complete();
    }
  },
);

it("classifies a refused raw projection as an authority mismatch before backend invocation", async () => {
  const sessionId = "refused-projection";
  const sessionKey = "agent:main:refused-projection";
  const queueMessage = vi.fn(async () => {});
  const handle = {
    ...createEmbeddedRunHandle({ runId: "refused-run", toolAuthorityFingerprint: "creator" }),
    messageInjectionV2: {
      version: 2 as const,
      isAvailable: () => true,
      queueMessage,
      queueMessageAsync: queueMessage,
    },
  };
  await withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey,
      embeddedRunToolAuthorityBinding: () => ({
        source: "attempt",
        assertActive: () => {},
        project: () => undefined,
        projectAsync: async () => {
          throw new Error("caller policy differs");
        },
      }),
    },
    () => setActiveEmbeddedRun(sessionId, handle, sessionKey),
  );
  await expect(
    queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "refused", {
      isInboundUserMessage: true,
      toolAuthorityOverlay: {
        senderIsOwner: false,
        disableTools: false,
        traceAuthorized: false,
      },
    }),
  ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
  expect(queueMessage).not.toHaveBeenCalled();
});

it.each([
  { backend: "legacy", revoked: false },
  { backend: "legacy", revoked: true },
  { backend: "prepared", revoked: false },
  { backend: "prepared", revoked: true },
] as const)(
  "refreshes Talk caller policy before $backend enqueue (revoked: $revoked)",
  async ({ backend, revoked }) => {
    const sessionId = `talk-policy-${backend}-${revoked}`;
    const sessionKey = `agent:main:${sessionId}`;
    const run = createQueueTestRun({ prompt: "preserve this Talk input" });
    Object.assign(run.run, { agentId: "main", sessionId, sessionKey });
    const operation = createTestReplyOperation({ sessionId, sessionKey });
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
    const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const enqueue = vi.fn();
    const waitForCaller = async () => {
      entered.resolve();
      await resume.promise;
    };
    const injection: ReplyBackendMessageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, _options, assertCurrent) => {
        await waitForCaller();
        assertCurrent();
        enqueue(text);
      },
      ...(backend === "prepared"
        ? {
            queueMessageAsync: (async (text, _options, preparation) => {
              await waitForCaller();
              await preparation.prepareCurrent();
              preparation.assertCurrent();
              enqueue(text);
            }) satisfies NonNullable<ReplyBackendMessageInjectionV2["queueMessageAsync"]>,
          }
        : {}),
    };
    const handle = {
      ...createEmbeddedRunHandle({ runId: sessionId, toolAuthorityFingerprint: fingerprint }),
      kind: "embedded" as const,
      cancel() {},
      messageInjectionV2: injection,
    };
    operation.attachBackend(handle);
    operation.setPhase("running");
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    let overlay: ReplyToolAuthorityOverlay = {
      senderIsOwner: false,
      disableTools: false,
      traceAuthorized: false,
    };
    const outcome = controlRealtimeVoiceAgentRun({
      sessionKey,
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
      await expect(outcome).resolves.toMatchObject({ queued: !revoked });
      if (revoked) {
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
