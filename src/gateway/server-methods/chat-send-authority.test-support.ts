import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import type { ReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";

type ProjectedDispatchOptions = Parameters<
  typeof dispatch.dispatchInboundMessageWithProjectedDispatcher
>[0];

export function bindSteeringTools(
  operation: ReplyOperation,
  fingerprint: string,
  overrides: Partial<Parameters<ReplyOperation["bindToolAuthoritySnapshot"]>[0]> = {},
) {
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => fingerprint,
    project: () => fingerprint,
    ...overrides,
  });
  operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
}

export function holdProjectedChatDispatch() {
  const entered = createDeferred<ProjectedDispatchOptions>();
  const release = createDeferred();
  const observe = vi.spyOn(chatDispatch, "startChatDispatch");
  const hold = vi
    .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
    .mockImplementation(async (options) => {
      entered.resolve(options);
      await release.promise;
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
  return { entered, release, observe, hold };
}

export async function loadRealChatDispatch() {
  const actualDispatch = await vi.importActual<typeof import("../../auto-reply/dispatch.js")>(
    "../../auto-reply/dispatch.js",
  );
  const actualReply = await vi.importActual<typeof import("../../auto-reply/reply/get-reply.js")>(
    "../../auto-reply/reply/get-reply.js",
  );
  return (params: Parameters<typeof dispatch.dispatchInboundMessage>[0]) =>
    actualDispatch.dispatchInboundMessage({
      ...params,
      replyResolver: actualReply.getReplyFromConfig,
    });
}

export function successfulChatTurn(
  runId: string,
  text: string,
): Awaited<ReturnType<typeof executeAgentTurn>> {
  return {
    runId,
    outcome: {
      kind: "settled",
      status: "ok",
      result: { payloads: [{ text }], meta: { durationMs: 0 } },
      resolved: { provider: "openai", model: "gpt-test" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
  };
}
