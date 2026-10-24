import { onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as questionDispatch from "../harness/gateway-question-dispatch.js";
import type { createAskUserTool } from "./ask-user-tool.js";

type GatewayCall = Extract<
  NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>,
  (...args: never[]) => unknown
>;
const resolveGatewayCall = questionDispatch.resolveAgentQuestionGatewayCall;

export const validArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [
        { label: "Staging (Recommended)", description: "Safer default" },
        { label: "Production" },
      ],
    },
  ],
};

export function gatewayStub(
  implementation: (
    method: string,
    opts: Record<string, unknown>,
    params: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => Promise<unknown>,
) {
  const started = {
    "question.request": createDeferred(),
    "question.waitAnswer": createDeferred(),
  };
  const mock = vi.fn((...args: Parameters<typeof implementation>) => {
    const response = implementation(...args);
    const [method] = args;
    // Callback setup has completed, but the owner's later prompt-delivery phase
    // is not implied by starting either RPC.
    if (method === "question.request" || method === "question.waitAnswer") {
      started[method].resolve();
    }
    return response;
  });
  // SAFETY: Each fixture selects its response by RPC method; this mock forwards the exact call and promise unchanged.
  const call = resolveGatewayCall(mock as GatewayCall);
  const resolver = vi
    .spyOn(questionDispatch, "resolveAgentQuestionGatewayCall")
    .mockReturnValue(call);
  onTestFinished(() => resolver.mockRestore());
  return {
    mock,
    call,
    waitForCall: (method: keyof typeof started, operation: PromiseLike<unknown>) =>
      awaitGateBeforeSettlement(
        started[method].promise,
        operation,
        `ask_user settled before starting ${method}`,
      ),
  };
}
