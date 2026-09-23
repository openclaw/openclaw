import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  readProviderReviewAcknowledgment,
  retireProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { projectSessionProviderReview } from "../session-provider-review-projection.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { soloClient } from "./sessions-sharing.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  handoff: vi.fn(),
  resolveTarget: vi.fn(),
  resolveAuthorization: vi.fn(),
}));
vi.mock("../../config/sessions/provider-review-store.js", () => ({
  readSessionProviderReview: mocks.read,
}));
vi.mock("./chat-send-handler.js", () => ({
  handleProviderReviewContinuationChat: mocks.handoff,
}));
vi.mock("../session-sharing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-sharing.js")>();
  return {
    ...actual,
    resolveSessionSharingTarget: mocks.resolveTarget,
    resolveSessionMutationAuthorization: mocks.resolveAuthorization,
  };
});

const sessionKey = "agent:main:provider-review";
const sessionId = "session-a";
const message = "/stop e\u0301\n ";
let entry: SessionEntry;
let sourceCurrent: boolean;
const assertCurrent = () => {
  if (!sourceCurrent) {
    throw new Error("source revoked");
  }
};

function request(overrides: Record<string, unknown> = {}): GatewayRequestHandlerOptions {
  const client = soloClient();
  const params = {
    sessionKey,
    agentId: "main",
    sessionId,
    reviewId: "review-a",
    idempotencyKey: "next-run",
    ...overrides,
  };
  return {
    req: { type: "req", id: "request-a", method: "sessions.providerReview.continue", params },
    params,
    client: {
      ...client,
      connId: "operator-a",
      connect: {
        ...client.connect,
        client: { ...client.connect.client, mode: "ui" },
      },
    },
    isWebchatConnect: () => true,
    respond: vi.fn(),
    context: createDirectChatContext({ getRuntimeConfig: () => ({}) }),
    hasCurrentClientAuthority: () => sourceCurrent,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sourceCurrent = true;
  entry = {
    sessionId,
    lifecycleRevision: "revision-a",
    updatedAt: 1,
    providerReview: {
      id: "review-a",
      sessionId,
      runId: "failed-run",
      provider: "openai",
      model: "gpt-5.6-sol",
      runtimeId: "codex",
      api: "openai-chatgpt-responses",
      nativeThreadId: "native-thread",
      nativeTurnId: "native-failed-turn",
      review: { explanation: "Review the proposed operation.", continuation: { message } },
    },
  };
  mocks.read.mockImplementation(async () => structuredClone(entry));
  mocks.resolveTarget.mockImplementation(() => ({
    agentId: "main",
    canonicalKey: sessionKey,
    storeKey: sessionKey,
    storePath: "/synthetic/session-store",
    entry,
  }));
  mocks.resolveAuthorization.mockReturnValue({
    authorization: {
      assertCurrent,
      assertAdmittedInputCurrent: assertCurrent,
      assertTargetCurrent: assertCurrent,
    },
    error: null,
  });
  mocks.handoff.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const [, acknowledgment] of mocks.handoff.mock.calls) {
    retireProviderReviewAcknowledgment(acknowledgment as ProviderReviewAcknowledgment);
  }
});

describe("registered provider review continuation", () => {
  it("hands the reviewed literal input and host capability to ordinary chat admission", async () => {
    const options = request();
    await coreGatewayHandlers["sessions.providerReview.continue"]!(options);
    expect(mocks.handoff).toHaveBeenCalledTimes(1);
    const [chatOptions, acknowledgment] = mocks.handoff.mock.calls[0] as [
      GatewayRequestHandlerOptions,
      ProviderReviewAcknowledgment,
    ];
    expect(chatOptions.params).toEqual({
      sessionKey,
      agentId: "main",
      sessionId,
      message,
      idempotencyKey: "next-run",
      deliver: false,
    });
    expect(readProviderReviewAcknowledgment(acknowledgment).review.id).toBe("review-a");
    const normalized = normalizeChatSendRequest({
      params: chatOptions.params,
      client: chatOptions.client,
      providerReviewAcknowledgment: acknowledgment,
    });
    expect(normalized).toMatchObject({
      ok: true,
      value: {
        inboundMessage: message,
        rawMessage: message,
        suppressCommandInterpretation: true,
        stopCommand: false,
        turnKind: "main",
      },
    });
    expect(entry.providerReview?.id).toBe("review-a");
  });

  it.each(["review", "generation", "authority"])(
    "rejects %s changes during the awaited read",
    async (change) => {
      mocks.read.mockImplementation(async () => {
        if (change === "review") {
          entry.providerReview!.id = "new-review";
        }
        if (change === "generation") {
          entry.lifecycleRevision = "new-generation";
        }
        if (change === "authority") {
          sourceCurrent = false;
        }
        return structuredClone(entry);
      });
      const options = request();
      await coreGatewayHandlers["sessions.providerReview.continue"]!(options);
      expect(mocks.handoff).not.toHaveBeenCalled();
      expect(options.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );

  it.each([
    { message: "replacement steer" },
    { responsesapiClientMetadata: { misalignment_override: "fake" } },
    { providerReviewAcknowledgment: {} },
  ])("rejects client-supplied continuation authority %j", async (overrides) => {
    const options = request(overrides);
    await coreGatewayHandlers["sessions.providerReview.continue"]!(options);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.handoff).not.toHaveBeenCalled();
    expect(options.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects agent-authored synthetic UI calls before reading the findings", async () => {
    const options = request();
    options.client!.internal = { syntheticClient: true };
    await coreGatewayHandlers["sessions.providerReview.continue"]!(options);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.handoff).not.toHaveBeenCalled();
    expect(options.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("shows ordinary API findings without offering or dispatching continuation", async () => {
    Object.assign(entry.providerReview!, { runtimeId: "openclaw", api: "openai-responses" });
    expect(projectSessionProviderReview(entry, sessionKey)).toEqual({
      id: "review-a",
      runId: "failed-run",
      explanation: "Review the proposed operation.",
      canContinue: false,
    });
    const options = request();
    await coreGatewayHandlers["sessions.providerReview.continue"]!(options);
    expect(mocks.handoff).not.toHaveBeenCalled();
    expect(options.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
