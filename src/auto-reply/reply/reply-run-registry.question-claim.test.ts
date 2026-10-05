import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { claimEmbeddedPendingUserInputAnswer } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import {
  QuestionDispatchRefusedError,
  type AgentQuestionDispatcher,
} from "../../agents/harness/gateway-question-dispatch.js";
import {
  claimPendingAgentQuestionAnswer,
  registerPendingAgentQuestion,
} from "../../agents/harness/gateway-question.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../../agents/harness/host-private-capabilities.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { EmbeddedQuestionBroker } from "../../infra/embedded-question-broker.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveReplySteeringAuthority } from "./agent-runner-fallback-authority.js";
import { claimPendingReplyQuestionInput } from "./agent-runner-question-input.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  claimPendingReplyMessageInjectionTarget,
  replyRunRegistry,
  type ReplyBackendQueueMessageOptions,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import {
  prepareReplyToolAuthority,
  resolveInboundReplyToolAuthorityOverlay,
} from "./reply-tool-authority.js";

afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

it("claims a pending V2 input before admitting a successor reply operation", async () => {
  const claimPendingUserInputAnswer = vi.fn(
    async (
      _text: string,
      _options: ReplyBackendQueueMessageOptions | undefined,
      assertCurrent: () => void,
    ) => {
      assertCurrent();
      return true;
    },
  );
  const operation = createTestReplyOperation({ sessionId: "session-question-claim" });
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => "creator-authority",
    project: (overlay) => (overlay.senderIsOwner ? "creator-authority" : "different-authority"),
  });
  operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
  operation.attachBackend({
    kind: "embedded",
    runId: "run-question-claim",
    toolAuthorityFingerprint: "creator-authority",
    cancel: vi.fn(),
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: vi.fn(async () => {}),
      claimPendingUserInputAnswer,
    },
  });
  operation.setPhase("running");
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;

  await expect(
    claimPendingReplyMessageInjectionTarget({
      target,
      text: "Continue",
      options: {
        isInboundUserMessage: true,
        toolAuthorityOverlay: {
          senderIsOwner: true,
          disableTools: false,
          traceAuthorized: false,
        },
      },
      assertSourceCurrent: () => {},
    }),
  ).resolves.toBe(true);
  expect(claimPendingUserInputAnswer).toHaveBeenCalledWith(
    "Continue",
    expect.objectContaining({
      isInboundUserMessage: true,
      toolAuthorityFingerprint: "creator-authority",
    }),
    expect.any(Function),
    "source-bound",
  );
});

it.each([false, true, undefined])(
  "preserves owner profile admission for a host pending claim (cross-profile: %s)",
  async (supportsCrossProfileSteering) => {
    const authority = (profileId: string) =>
      createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        assertCurrent() {},
      });
    const operation = createTestReplyOperation();
    operation.bindToolAuthoritySnapshot({
      personalToolOwner: { operatorAuthority: authority("alice") },
      fingerprint: () => "same-authority",
      project: () => "same-authority",
    });
    operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
    const resolved = vi.fn();
    const question = withAgentQuestionAnswerAuthority(
      createAgentQuestionAnswerAuthority({
        sessionKey: operation.key,
        fingerprint: "same-authority",
        project: () => "same-authority",
        assertActive() {},
      }),
      () =>
        registerPendingAgentQuestion({
          sessionKey: operation.key,
          questionId: "ask_profile_claim",
          questions: [{ id: "answer", header: "Answer", question: "Continue?", options: [] }],
          answer: Promise.resolve({ status: "pending" }),
          gatewayCall: {
            version: 2,
            call: async ({ authority: requestAuthority }) => {
              if (requestAuthority.kind === "source-bound") {
                requestAuthority.assertCurrent();
              }
              resolved();
              return {};
            },
          } satisfies AgentQuestionDispatcher,
        }),
    );
    question.attachRegistration(Promise.resolve());
    operation.attachBackend({
      kind: "embedded",
      toolAuthorityFingerprint: "same-authority",
      supportsCrossProfileSteering,
      cancel: vi.fn(),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: vi.fn(async () => {}),
        claimPendingUserInputAnswer: async (text, _options, assertCurrent) =>
          claimPendingAgentQuestionAnswer({
            sessionKey: operation.key,
            text,
            authority: { kind: "source-bound", assertCurrent },
          }),
      },
    });
    operation.setPhase("running");
    const onAnswerProcessed = vi.fn();
    try {
      const claim = claimPendingReplyQuestionInput({
        sessionKey: operation.key,
        text: "Continue",
        caller: {
          operatorAuthority: authority("bob"),
          senderIsOwner: true,
          disableTools: false,
          traceAuthorized: false,
        },
        assertSourceCurrent() {},
        onAnswerProcessed,
      });
      if (supportsCrossProfileSteering === false) {
        await expect(claim).rejects.toBeInstanceOf(QuestionDispatchRefusedError);
        expect(resolved).not.toHaveBeenCalled();
        expect(onAnswerProcessed).not.toHaveBeenCalled();
        expect(() => operation.personalToolParticipants?.resolve("bob")).toThrow(
          "User is not a participant",
        );
      } else {
        await expect(claim).resolves.toBe(true);
        expect(resolved).toHaveBeenCalledOnce();
        expect(onAnswerProcessed).toHaveBeenCalledOnce();
        expect(operation.personalToolParticipants?.resolve("bob")?.profileId).toBe("bob");
      }
    } finally {
      question.dispose();
    }
  },
);

it("rejects a lower-authority caller before V2 question-resolution I/O", async () => {
  const claimPendingUserInputAnswer = vi.fn(
    async (
      _text: string,
      _options: ReplyBackendQueueMessageOptions | undefined,
      assertCurrent: () => void,
    ) => {
      assertCurrent();
      return true;
    },
  );
  const operation = createTestReplyOperation({ sessionId: "session-question-denied" });
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => "creator-authority",
    project: () => "lower-authority",
  });
  operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
  operation.attachBackend({
    kind: "embedded",
    runId: "run-question-denied",
    toolAuthorityFingerprint: "creator-authority",
    cancel: vi.fn(),
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: vi.fn(async () => {}),
      claimPendingUserInputAnswer,
    },
  });
  operation.setPhase("running");
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;

  await expect(
    claimPendingReplyMessageInjectionTarget({
      target,
      text: "Continue",
      options: {
        isInboundUserMessage: true,
        toolAuthorityOverlay: {
          senderIsOwner: false,
          disableTools: false,
          traceAuthorized: false,
        },
      },
      assertSourceCurrent: () => {},
    }),
  ).rejects.toBeInstanceOf(QuestionDispatchRefusedError);
  expect(claimPendingUserInputAnswer).toHaveBeenCalledOnce();
});

it("lets a differing-authority ordinary message fall through without a pending question", async () => {
  const claimPendingUserInputAnswer = vi.fn(async () => false);
  const operation = createTestReplyOperation({ sessionId: "session-no-question" });
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => "creator-authority",
    project: () => "lower-authority",
  });
  operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
  operation.attachBackend({
    kind: "embedded",
    runId: "run-no-question",
    toolAuthorityFingerprint: "creator-authority",
    cancel: vi.fn(),
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: vi.fn(async () => {}),
      claimPendingUserInputAnswer,
    },
  });
  operation.setPhase("running");
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;

  await expect(
    claimPendingReplyMessageInjectionTarget({
      target,
      text: "ordinary follow-up",
      options: {
        isInboundUserMessage: true,
        toolAuthorityOverlay: {
          senderIsOwner: false,
          disableTools: false,
          traceAuthorized: false,
        },
      },
      assertSourceCurrent: () => {},
    }),
  ).resolves.toBe(false);
  expect(claimPendingUserInputAnswer).toHaveBeenCalledOnce();
});

it("rejects a lower-authority question registered during V2 backend preparation", async () => {
  const sessionKey = "agent:main:question-fallback-race";
  const questionResolve = vi.fn();
  const gatewayCall: AgentQuestionDispatcher = {
    version: 2,
    call: async (request) => {
      if (request.authority.kind === "source-bound") {
        request.authority.assertCurrent();
      }
      if (request.method === "question.resolve") {
        questionResolve();
      }
      return {};
    },
  };
  // Mirrors the bundled adapter: the backend relies on the supplied
  // source-bound assertion and does not compare tool fingerprints itself.
  const backendStarted = createDeferred();
  const releaseBackend = createDeferred();
  const backendClaim = vi.fn(
    async (
      text: string,
      _options: ReplyBackendQueueMessageOptions | undefined,
      assertCurrent: () => void,
    ) => {
      backendStarted.resolve();
      await releaseBackend.promise;
      return await claimPendingAgentQuestionAnswer({
        sessionKey,
        text,
        authority: { kind: "source-bound", assertCurrent },
      });
    },
  );
  const operation = createTestReplyOperation({ sessionKey, sessionId: "fallback-race" });
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => "creator-authority",
    project: () => "lower-authority",
  });
  operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
  operation.attachBackend({
    kind: "embedded",
    runId: "fallback-race-run",
    toolAuthorityFingerprint: "creator-authority",
    cancel: vi.fn(),
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: vi.fn(async () => {}),
      claimPendingUserInputAnswer: backendClaim,
    },
  });
  operation.setPhase("running");

  // A pending request can appear after target capture and before the backend claim.
  const claim = claimPendingReplyQuestionInput({
    sessionKey,
    text: "Continue",
    caller: {
      senderIsOwner: false,
      disableTools: false,
      traceAuthorized: false,
    },
    assertSourceCurrent: () => {},
  });
  await backendStarted.promise;
  const question = registerPendingAgentQuestion({
    sessionKey,
    questionId: "ask_fallback_race",
    questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
    gatewayCall,
  });
  question.attachRegistration(Promise.resolve());
  releaseBackend.resolve();
  try {
    await expect(claim).rejects.toBeInstanceOf(QuestionDispatchRefusedError);
    expect(backendClaim).toHaveBeenCalledOnce();
    expect(questionResolve).not.toHaveBeenCalled();
  } finally {
    question.dispose();
    operation.complete();
  }
});

it.each(["source-revoked", "operation-reassigned"] as const)(
  "blocks V2 final question I/O when $case during backend preparation",
  async (testCase) => {
    const backendEntered = createDeferred();
    const releaseBackend = createDeferred();
    const questionResolve = vi.fn();
    const source = new AbortController();
    let replacement: ReplyOperation | undefined;
    const claimPendingUserInputAnswer = vi.fn(
      async (
        _text: string,
        _options: ReplyBackendQueueMessageOptions | undefined,
        assertCurrent: () => void,
      ) => {
        backendEntered.resolve();
        await releaseBackend.promise;
        assertCurrent();
        questionResolve();
        return true;
      },
    );
    const operation = createTestReplyOperation({ sessionId: `session-${testCase}` });
    operation.bindToolAuthoritySnapshot({
      fingerprint: () => "creator-authority",
      project: () => "creator-authority",
    });
    operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
    operation.attachBackend({
      kind: "embedded",
      runId: `run-${testCase}`,
      toolAuthorityFingerprint: "creator-authority",
      cancel: vi.fn(),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: vi.fn(async () => {}),
        claimPendingUserInputAnswer,
      },
    });
    operation.setPhase("running");
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;

    const claim = claimPendingReplyMessageInjectionTarget({
      target,
      text: "Continue",
      options: {
        isInboundUserMessage: true,
        toolAuthorityOverlay: {
          senderIsOwner: true,
          disableTools: false,
          traceAuthorized: false,
        },
      },
      assertSourceCurrent: () => source.signal.throwIfAborted(),
    });
    await backendEntered.promise;
    if (testCase === "source-revoked") {
      source.abort();
    } else {
      operation.complete();
      replacement = createTestReplyOperation({ sessionId: "replacement-session" });
    }
    releaseBackend.resolve();

    await expect(claim).rejects.toBeInstanceOf(QuestionDispatchRefusedError);
    expect(questionResolve).not.toHaveBeenCalled();
    replacement?.complete();
    if (!operation.result) {
      operation.complete();
    }
  },
);

it.each([
  "accepted",
  "cross-profile-disabled",
  "altered-tools",
  "stale-proof",
  "source-revoked",
  "creator-route-changed",
  "creator-reassigned",
] as const)("keeps the production host pending fallback boundary for %s", async (outcome) => {
  const sessionKey = `agent:main:pending-fallback-${outcome}`;
  const run = createQueueTestRun({ prompt: "Continue" });
  run.run.config = { agents: { defaults: { model: { primary: "openai/gpt-test" } } } };
  const modelPolicy = prepareOperatorModelPolicy({ cfg: run.run.config, policy: {} });
  const operator = (profileId: string) =>
    createAdmittedRunOperatorAuthority({
      profileId,
      scopes: ["operator.read", "operator.write"],
      gatewayAccessGrant: null,
      modelPolicy,
      assertCurrent() {},
    });
  run.operatorAuthority = operator("alice");
  Object.assign(run.run, {
    senderId: "alice-sender",
    senderName: "Alice",
    senderIsOwner: true,
    clientCaps: ["ui-commands"],
    gatewayUiCommandTarget: { connId: "alice-tab", profileId: "alice" },
  });
  const operation = createTestReplyOperation({ sessionKey });
  operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
  operation.bindToolAuthorityRoute({ provider: "openai", model: "gpt-fallback" });
  const creatorFingerprint = operation.toolAuthorityFingerprint!;
  run.operatorAuthority = operator("bob");
  Object.assign(run.run, {
    senderId: "bob-sender",
    senderName: "Bob",
    modelSelectionLocked: true,
    gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
  });
  if (outcome === "altered-tools") {
    run.toolsAllow = ["read"];
  }
  const pendingProof = resolveReplySteeringAuthority(
    run,
    operation,
  ).pendingInputAuthorityFingerprint;
  expect(pendingProof).toBe(outcome === "altered-tools" ? undefined : creatorFingerprint);
  const caller = resolveInboundReplyToolAuthorityOverlay({
    ctx: {},
    senderIsOwner: true,
    operatorAuthority: run.operatorAuthority,
    toolsAllow: run.toolsAllow,
    disableTools: false,
  });
  expect(operation.projectToolAuthorityFingerprint(caller)).not.toBe(creatorFingerprint);
  const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler());
  const questionId = `ask_pending_fallback_${outcome}`;
  const questions = [{ id: "answer", header: "Answer", question: "Continue?", options: [] }];
  broker.request({
    id: questionId,
    sessionKey,
    questions: questions.map(({ id, ...question }) => ({ ...question, questionId: id })),
  });
  const resolved = vi.fn();
  const gatewayCall: AgentQuestionDispatcher = {
    version: 2,
    call: async (request) => {
      if (request.authority.kind === "source-bound") {
        request.authority.assertCurrent();
      }
      if (request.method === "question.resolve") {
        resolved();
      }
      return broker.call(request.method, request.params);
    },
  };
  const question = withAgentQuestionAnswerAuthority(
    createAgentQuestionAnswerAuthority({
      sessionKey,
      fingerprint: creatorFingerprint,
      project: (overlay) => operation.projectToolAuthorityFingerprint(overlay) ?? "missing-owner",
      assertActive() {},
    }),
    () =>
      registerPendingAgentQuestion({
        sessionKey,
        questionId,
        questions,
        gatewayCall,
        answer: broker.waitAnswer({ id: questionId, includeResolutionId: true }),
      }),
  );
  question.attachRegistration(Promise.resolve());
  const backendEntered = createDeferred();
  const releaseBackend = createDeferred();
  const source = new AbortController();
  let replacement: ReplyOperation | undefined;
  const claimPendingUserInputAnswer = vi.fn(
    async (
      text: string,
      options: ReplyBackendQueueMessageOptions | undefined,
      assertCurrent: () => void,
    ) => {
      backendEntered.resolve();
      await releaseBackend.promise;
      return await claimEmbeddedPendingUserInputAnswer(
        text,
        options,
        sessionKey,
        () => true,
        { kind: "source-bound", assertCurrent },
        creatorFingerprint,
      );
    },
  );
  operation.attachBackend({
    kind: "embedded",
    cancel: vi.fn(),
    ...(outcome === "cross-profile-disabled" ? { supportsCrossProfileSteering: false } : {}),
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: vi.fn(async () => {}),
      claimPendingUserInputAnswer,
    },
  });
  operation.setPhase("running");
  const onAnswerProcessed = vi.fn();
  try {
    const claim = claimPendingReplyQuestionInput({
      sessionKey,
      text: "Continue",
      caller,
      personalToolParticipant: {
        operatorAuthority: run.operatorAuthority,
        senderId: run.run.senderId,
        senderName: run.run.senderName,
        gatewayUiCommandTarget: run.run.gatewayUiCommandTarget,
      },
      pendingInputAuthorityFingerprint: outcome === "stale-proof" ? "stale-proof" : pendingProof,
      assertSourceCurrent: () => source.signal.throwIfAborted(),
      onAnswerProcessed,
    });
    await backendEntered.promise;
    if (outcome === "source-revoked") {
      source.abort();
    } else if (outcome === "creator-route-changed") {
      operation.bindToolAuthorityRoute({ provider: "openai", model: "new-fallback" });
    } else if (outcome === "creator-reassigned") {
      operation.complete();
      replacement = createTestReplyOperation({ sessionKey, sessionId: "replacement-session" });
    }
    releaseBackend.resolve();
    if (outcome === "accepted") {
      await expect(claim).resolves.toBe(true);
      expect(resolved).toHaveBeenCalledOnce();
      expect(onAnswerProcessed).toHaveBeenCalledOnce();
      expect(broker.get({ id: questionId }).question).toMatchObject({ status: "answered" });
      expect(operation.personalToolParticipants?.resolve("bob")).toMatchObject({
        profileId: "bob",
        name: "Bob",
        gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
      });
      expect(claimPendingUserInputAnswer).toHaveBeenCalledWith(
        "Continue",
        expect.objectContaining({
          pendingInputAuthorityFingerprint: creatorFingerprint,
          toolAuthorityFingerprint: creatorFingerprint,
        }),
        expect.any(Function),
        "source-bound",
      );
    } else {
      await expect(claim).rejects.toBeInstanceOf(QuestionDispatchRefusedError);
      expect(resolved).not.toHaveBeenCalled();
      expect(onAnswerProcessed).not.toHaveBeenCalled();
      expect(broker.get({ id: questionId }).question).toMatchObject({ status: "pending" });
      expect(broker.get({ id: questionId }).question.answers).toBeUndefined();
      expect(question.isResolving()).toBe(false);
      expect(() => operation.personalToolParticipants?.resolve("bob")).toThrow(
        outcome === "creator-reassigned"
          ? "This turn has ended; ask again in a new turn."
          : "User is not a participant",
      );
      if (replacement) {
        expect(replacement.personalToolParticipants).toBeUndefined();
      }
    }
  } finally {
    releaseBackend.resolve();
    question.dispose();
    broker.stop();
    replacement?.complete();
    if (!operation.result) {
      operation.complete();
    }
  }
});
