import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  QuestionDispatchRefusedError,
  type AgentQuestionDispatcher,
} from "../../agents/harness/gateway-question-dispatch.js";
import {
  claimPendingAgentQuestionAnswer,
  registerPendingAgentQuestion,
} from "../../agents/harness/gateway-question.js";
import { claimPendingReplyQuestionInput } from "./agent-runner-question-input.js";
import {
  claimPendingReplyMessageInjectionTarget,
  replyRunRegistry,
  type ReplyBackendQueueMessageOptions,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";

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

it("rejects a lower-authority question registered between host lookup and V2 fallback", async () => {
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
  const backendClaim = vi.fn(
    async (
      text: string,
      _options: ReplyBackendQueueMessageOptions | undefined,
      assertCurrent: () => void,
    ) =>
      await claimPendingAgentQuestionAnswer({
        sessionKey,
        text,
        authority: { kind: "source-bound", assertCurrent },
      }),
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

  // The first host lookup starts with no pending question and yields before
  // falling back to the active native backend.
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
  const question = registerPendingAgentQuestion({
    sessionKey,
    questionId: "ask_fallback_race",
    questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
    gatewayCall,
  });
  question.attachRegistration(Promise.resolve());
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
