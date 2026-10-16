import { expect, it } from "vitest";
import type {
  WorkerTranscriptCommitParams,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  type WorkerInferenceStartParams,
  type WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "./transcript-message.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

type WorkerDoneMessage = Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"];
type WorkerReplayFixture = {
  setup: (options: { inferencePlans: Array<"tool" | "text"> }) => Promise<{
    gateway: {
      inferenceRequests: WorkerInferenceStartParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
    };
    launch: WorkerLaunchDescriptor;
  }>;
  assistantMessage: (
    content: WorkerDoneMessage["content"],
    stopReason: WorkerDoneMessage["stopReason"],
  ) => WorkerDoneMessage;
  modelRef: { model: string };
};

export function registerWorkerReplayWindowTests({
  setup,
  assistantMessage,
  modelRef: MODEL_REF,
}: WorkerReplayFixture) {
  const WORKER_LOOP_REPLAY = {
    v: 1 as const,
    type: "openai-responses-compaction",
    data: "opaque-worker-loop-replay",
    provider: "openai",
    api: "openai-responses",
    model: MODEL_REF.model,
    baseUrlHash: "ozhevd1smnk8s",
  };

  it("keeps a pinned replay anchor through repeated local tool-loop inference", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["tool", "text"] });
    launch.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 2 },
      (_value, index): WorkerTranscriptMessage => ({
        role: "user",
        content: [{ type: "text", text: `history-${index}` }],
        timestamp: index + 1,
      }),
    );
    launch.assignment.initialMessages[2] = {
      ...assistantMessage([{ type: "text", text: "checkpoint suffix" }], "stop"),
      providerReplay: structuredClone(WORKER_LOOP_REPLAY),
    };

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests).toHaveLength(2);
    for (const request of gateway.inferenceRequests) {
      expect(request.context.messages.length).toBeLessThanOrEqual(
        WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
      );
      expect(request.context.messages[0]?.role).toBe("user");
      expect(
        request.context.messages.find(
          (message) => message.role === "assistant" && message.providerReplay,
        ),
      ).toMatchObject({ providerReplay: WORKER_LOOP_REPLAY });
    }
    expect(
      gateway.inferenceRequests[1]?.context.messages.some(
        (message) => message.role === "toolResult",
      ),
    ).toBe(true);
    expect(
      gateway.inferenceRequests[1]?.context.messages.slice(-3).map((message) => message.role),
    ).toEqual(["user", "assistant", "toolResult"]);
    expect(
      gateway.transcriptRequests
        .flatMap((request) => request.messages)
        .map((message) => message.role),
    ).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("fails before a second inference when the replay unit outgrows the window", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["tool", "text"] });
    launch.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 1 },
      (_value, index): WorkerTranscriptMessage => ({
        role: "user",
        content: [{ type: "text", text: `history-${index}` }],
        timestamp: index + 1,
      }),
    );
    launch.assignment.initialMessages[0] = {
      ...assistantMessage([{ type: "text", text: "checkpoint suffix" }], "stop"),
      providerReplay: structuredClone(WORKER_LOOP_REPLAY),
    };

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({
      status: "failed",
      reason: "turn-failed",
      transcriptLeafId: expect.any(String),
      transcriptNextSeq: expect.any(Number),
    });

    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(gateway.inferenceRequests[0]?.context.messages).toHaveLength(
      WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
    );
    expect(gateway.inferenceRequests[0]?.context.messages[0]).toMatchObject({
      providerReplay: WORKER_LOOP_REPLAY,
    });
    const terminal = gateway.transcriptRequests
      .flatMap((request) => request.messages)
      .toReversed()
      .find((message) => message.role === "assistant");
    expect(terminal).toMatchObject({
      stopReason: "error",
      errorMessage: `${WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE} (provider-replay-message-limit)`,
    });
  });
}
