import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { abortChatRunsForSessionKeyWithPartials } from "./chat-abort-runtime.js";
import { requireLastRespondCall } from "./chat.abort-authorization.test-helpers.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

const reviewMocks = vi.hoisted(() => ({
  stopReview: vi.fn(),
}));

vi.mock("../../skills/workshop/experience-review-default.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/workshop/experience-review-default.js")>()),
  stopSkillExperienceReview: reviewMocks.stopReview,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async () => ({
    entry: { sessionId: "main-session" },
    storePath: "/synthetic/experience-review/sessions.json",
  }),
}));

const sessionKey = "agent:main:main";
const storeScope = "/synthetic/experience-review/sessions.json";
const owner = { connId: "conn-owner", deviceId: "dev-owner" };

function createRun(runId: string, queued = false) {
  return createActiveRun(sessionKey, {
    sessionId: "main-session",
    agentId: "main",
    storeScope,
    queued,
    runId,
  });
}

function reviewCall() {
  expect(reviewMocks.stopReview).toHaveBeenCalledOnce();
  return reviewMocks.stopReview.mock.calls[0]![0] as {
    sessions: { agentId?: string; sessionKey?: string }[];
    runIds: Iterable<string>;
  };
}

beforeEach(() => {
  reviewMocks.stopReview.mockReset();
});

describe("explicit chat Stop covers Workshop Experience Review", () => {
  it("cancels the review and suppresses the selected run for a plain chat.abort", async () => {
    const runId = "review-stop-run";
    const run = createRun(runId);
    const context = createChatAbortContext({ sources: [[runId, run]] });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey },
      client: { connect: { scopes: ["operator.admin"] } },
    });

    expect(requireLastRespondCall(respond)[0]).toBe(true);
    const call = reviewCall();
    expect(call.sessions).toEqual([{ agentId: "main", sessionKey }]);
    expect([...call.runIds]).toContain(runId);
    expect(run.input.abortSignal.aborted).toBe(true);
  });

  it("leaves the review untouched when a rejected caller's Stop is unauthorized", async () => {
    const runId = "review-foreign-run";
    const run = createActiveRun(sessionKey, {
      sessionId: "main-session",
      agentId: "main",
      storeScope,
      runId,
      owner,
    });
    const context = createChatAbortContext({ sources: [[runId, run]] });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey },
      client: {
        connId: "conn-other",
        connect: { device: { id: "dev-other" }, scopes: ["operator.write"] },
      },
    });

    const [ok, , error] = requireLastRespondCall(respond);
    expect(ok).toBe(false);
    expect(error?.message).toBe("unauthorized");
    expect(reviewMocks.stopReview).not.toHaveBeenCalled();
    expect(run.input.abortSignal.aborted).toBe(false);
  });

  it("covers an exact-run Stop from a shipped chat client", async () => {
    const runId = "review-exact-run";
    const run = createActiveRun(sessionKey, {
      sessionId: "main-session",
      agentId: "main",
      storeScope,
      runId,
      owner,
    });
    const context = createChatAbortContext({ sources: [[runId, run]] });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey, runId },
      client: {
        connId: "conn-owner",
        connect: { device: { id: "dev-owner" }, scopes: ["operator.write"] },
      },
    });

    expect(requireLastRespondCall(respond)[1]).toMatchObject({
      ok: true,
      aborted: true,
      runIds: [runId],
    });
    const call = reviewCall();
    expect(call.sessions).toEqual([{ agentId: "main", sessionKey }]);
    expect([...call.runIds]).toEqual([runId]);
    expect(run.input.abortSignal.aborted).toBe(true);
  });

  it("does not touch reviews for queued-input discard", async () => {
    const runId = "review-discard-run";
    const run = createRun(runId, true);
    const context = createChatAbortContext({ sources: [[runId, run]] });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey, runId, discardPendingInput: true },
      client: { connect: { scopes: ["operator.admin"] } },
    });

    expect(requireLastRespondCall(respond)[0]).toBe(true);
    expect(reviewMocks.stopReview).not.toHaveBeenCalled();
  });

  it("does not touch reviews for a maintenance abort without the explicit-stop flag", async () => {
    const runId = "review-maintenance-run";
    const run = createRun(runId);
    const context = createChatAbortContext({ sources: [[runId, run]] });

    const result = await abortChatRunsForSessionKeyWithPartials({
      // The synthetic fixture carries only the abort fields this path reads.
      context: context as unknown as GatewayRequestContext,
      ops: createChatAbortOps(context),
      sessionKey,
      agentId: "main",
      abortOrigin: "rpc",
      stopReason: "archive",
      stopSource: "mutation",
      requester: { isAdmin: true },
    });

    expect(result.aborted).toBe(true);
    expect(reviewMocks.stopReview).not.toHaveBeenCalled();
  });
});
