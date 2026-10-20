import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import {
  readProviderReviewAcknowledgment,
  retireProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { projectSessionProviderReview } from "../session-provider-review-projection.js";
import type { handleProviderReviewContinuationChat as ReviewHandoff } from "./chat-send-handler.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { soloClient } from "./sessions-sharing.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  handoff: vi.fn<typeof ReviewHandoff>(),
  releaseAuthorization: vi.fn(),
}));
vi.mock("../../config/sessions/provider-review-store.js", () => ({
  readSessionProviderReview: mocks.read,
}));
vi.mock("./chat-send-handler.js", () => ({
  handleProviderReviewContinuationChat: mocks.handoff,
}));
vi.mock("../session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-sharing.js")>()),
  resolveSessionSharingTargetAsync: async () => ({
    agentId: "main",
    canonicalKey: sessionKey,
    storeKey: sessionKey,
    storePath: "/synthetic/session-store",
    entry,
  }),
}));
// mock-isolation: Provider-review tests control authorization changes while the review is awaited.
vi.mock("../session-sharing-authorization-async.js", () => ({
  resolveSessionMutationAuthorizationAsync: async () => ({
    authorization: {
      assertCurrent,
      assertAdmittedInputCurrent: assertCurrent,
      release: mocks.releaseAuthorization,
    },
    error: null,
  }),
}));

const sessionKey = "agent:main:provider-review";
const sessionId = "session-a";
const target = { sessionKey, agentId: "main", sessionId };
const requestParams = { ...target, reviewId: "review-a", idempotencyKey: "next-run" };
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
  client.connId = "operator-a";
  client.connect.client.mode = "ui";
  const params = { ...requestParams, ...overrides };
  return {
    req: { type: "req", id: "request-a", method: "sessions.providerReview.continue", params },
    params,
    client,
    isWebchatConnect: () => true,
    respond: vi.fn(),
    context: createDirectChatContext({ getRuntimeConfig: () => ({}) }),
    hasCurrentClientAuthority: () => sourceCurrent,
  };
}

async function reject(options: GatewayRequestHandlerOptions = request()) {
  await coreGatewayHandlers["sessions.providerReview.continue"]!(options);
  expect(mocks.handoff).not.toHaveBeenCalled();
  expect(options.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
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
  mocks.handoff.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const [, acknowledgment] of mocks.handoff.mock.calls) {
    retireProviderReviewAcknowledgment(acknowledgment);
  }
});

it("hands literal input and host capability to chat admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await coreGatewayHandlers["sessions.providerReview.continue"]!(request());
    expect(mocks.handoff).toHaveBeenCalledTimes(1);
    expect(mocks.releaseAuthorization).toHaveBeenCalledTimes(1);
    const [chatOptions, acknowledgment] = mocks.handoff.mock.calls[0]!;
    expect(chatOptions.params).toEqual({
      ...target,
      message,
      idempotencyKey: "next-run",
      deliver: false,
    });
    expect(readProviderReviewAcknowledgment(acknowledgment).review.id).toBe("review-a");
    await loadOrCreateProcessDeviceIdentityAsync();
    await expect(
      normalizeChatSendRequest({
        params: chatOptions.params,
        client: chatOptions.client,
        providerReviewAcknowledgment: acknowledgment,
      }),
    ).resolves.toMatchObject({
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
});

it.each(["review", "generation", "authority"])(
  "rejects awaited-read %s changes",
  async (change) => {
    mocks.read.mockImplementation(async () => {
      if (change === "review") {
        entry.providerReview!.id = "new-review";
      } else if (change === "generation") {
        entry.lifecycleRevision = "new-generation";
      } else {
        sourceCurrent = false;
      }
      return structuredClone(entry);
    });
    await reject();
  },
);

it.each(["client-supplied authority", "synthetic UI", "ordinary API"])(
  "rejects continuation from %s",
  async (source) => {
    const options = request(
      source === "client-supplied authority" ? { providerReviewAcknowledgment: {} } : {},
    );
    if (source === "synthetic UI") {
      options.client!.internal = { syntheticClient: true };
    } else if (source === "ordinary API") {
      Object.assign(entry.providerReview!, { runtimeId: "openclaw", api: "openai-responses" });
      expect(projectSessionProviderReview(entry, sessionKey)).toEqual({
        id: "review-a",
        runId: "failed-run",
        explanation: "Review the proposed operation.",
        canContinue: false,
      });
    }
    await reject(options);
    if (source !== "ordinary API") {
      expect(mocks.read).not.toHaveBeenCalled();
    }
  },
);
