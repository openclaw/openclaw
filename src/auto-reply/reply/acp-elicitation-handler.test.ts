import type { AcpElicitationRequest } from "@openclaw/acp-core/runtime/types";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentHarnessQuestionGatewayCall } from "../../agents/harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswer } from "../../agents/harness/gateway-question.js";

const gatewayCallMock = vi.hoisted(() => vi.fn<AgentHarnessQuestionGatewayCall>());

vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: gatewayCallMock }));

import { createAcpElicitationHandler } from "./acp-elicitation-handler.js";

type GatewayRequest = {
  id: string;
  questions: { questionId: string }[];
};

function formRequest(properties: Record<string, unknown>): AcpElicitationRequest {
  return {
    mode: "form",
    sessionId: "acp-session",
    toolCallId: "tool-call",
    message: "ACP needs input",
    requestedSchema: { type: "object", properties, required: Object.keys(properties) },
  };
}

const urlRequest: AcpElicitationRequest = {
  mode: "url",
  sessionId: "acp-session",
  toolCallId: "tool-call",
  message: "Authenticate",
  elicitationId: "login-1",
  url: "https://example.com/login",
};

const delivered: string[] = [];
const handler = createAcpElicitationHandler({
  sourceSessionKey: "agent:main:source",
  targetSessionKey: "agent:codex:acp:target",
  outerRequestId: "outer-turn",
  agentId: "main",
  runId: "run-1",
  delivery: {
    deliver: vi.fn(async (_kind, payload) => {
      if (payload.text) {
        delivered.push(payload.text);
      }
      return true;
    }),
  },
  isActive: () => true,
});

function context(requestId: string | number, signal = new AbortController().signal) {
  return { requestId, signal };
}

function answerGateway(
  answer: (
    questions: GatewayRequest["questions"],
    signal?: AbortSignal,
  ) => Record<string, string[]> | Promise<Record<string, string[]>>,
): GatewayRequest[] {
  const ordered: GatewayRequest[] = [];
  gatewayCallMock.mockImplementation(async (method, _opts, rawParams, extra) => {
    const params = rawParams as GatewayRequest;
    if (method === "question.request") {
      ordered.push(params);
      return { id: params.id };
    }
    if (method === "question.waitAnswer") {
      const request = ordered.find(({ id }) => id === params.id);
      if (!request) {
        throw new Error("missing question registration");
      }
      return {
        status: "answered",
        answers: { answers: await answer(request.questions, extra?.signal) },
      };
    }
    if (method === "question.resolve") {
      return { status: "cancelled" };
    }
    throw new Error(`unexpected gateway method ${method}`);
  });
  return ordered;
}

beforeEach(() => {
  gatewayCallMock.mockReset();
  delivered.length = 0;
});

it("rejects accessor-backed request objects without invoking the accessor", async () => {
  const getSchema = vi.fn(() => ({ type: "object", properties: { value: { type: "string" } } }));
  const request = Object.defineProperty(formRequest({}), "requestedSchema", {
    enumerable: true,
    get: getSchema,
  });
  expect((await handler(request, context("accessor"))).action).toBe("decline");
  expect(getSchema).not.toHaveBeenCalled();
  expect(delivered.join("\n")).toContain("malformed");
});

it("uses outer, scope, session, and tool-call correlation in Gateway records", async () => {
  const requests = answerGateway((questions) => ({ [questions[0]!.questionId]: ["Continue"] }));
  await handler(urlRequest, context(1));
  await handler(
    {
      mode: "url",
      requestId: "auth-request",
      message: "Authenticate",
      elicitationId: "login-2",
      url: "https://example.com/login",
    },
    context(2),
  );

  expect(requests).toHaveLength(2);
  expect(requests[0]?.id).not.toBe(requests[1]?.id);
  expect(requests[0]).toMatchObject({
    sessionKey: "agent:codex:acp:target",
    runId: "run-1",
  });
});

it("cancels an aborted request and rejects a late Gateway answer", async () => {
  const requests = answerGateway(
    (_questions, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("late answer")), { once: true });
      }),
  );
  const controller = new AbortController();
  const response = handler(urlRequest, context("abort", controller.signal));
  await vi.waitFor(() => expect(requests).toHaveLength(1));

  controller.abort();

  await expect(response).resolves.toMatchObject({ action: "cancel" });
});

it("keeps explicitly marked Codex secrets out of Gateway question records", async () => {
  gatewayCallMock.mockRejectedValue(new Error("secret must not reach Gateway questions"));
  const response = handler(
    formRequest({
      token: { type: "string", title: "Token", _meta: { codex: { isSecret: true } } },
    }),
    context("secret"),
  );
  await vi.waitFor(() => expect(delivered.join("\n")).toContain("may show your reply"));

  await expect(
    claimPendingAgentQuestionAnswer({
      sessionKey: "agent:codex:acp:target",
      text: "private-value",
    }),
  ).resolves.toBe(true);

  await expect(response).resolves.toEqual({
    action: "accept",
    content: { token: "private-value" },
  });
  expect(gatewayCallMock).not.toHaveBeenCalled();
});

it("asks before accepting an ACP form elicitation with an empty schema", async () => {
  const answerSubmitted = createDeferred();
  const requests = answerGateway(async (questions) => {
    await answerSubmitted.promise;
    return { [questions[0]!.questionId]: ["Allow"] };
  });
  const controller = new AbortController();
  const response = handler(formRequest({}), context("empty-form", controller.signal));
  const settled = vi.fn();
  void response.then(settled);
  try {
    await vi.waitFor(() => expect(delivered.join("\n")).toContain("ACP needs input"));
    expect(requests).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled();
    answerSubmitted.resolve();
    await expect(response).resolves.toEqual({ action: "accept", content: {} });
  } finally {
    controller.abort();
    answerSubmitted.resolve();
    await response;
  }
});
