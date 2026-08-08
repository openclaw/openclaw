import { describe, expect, it, vi } from "vitest";
import {
  type WorkerLiveEvent,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { UserMessage } from "../llm/types.js";
import { createWorkerLiveRuntime } from "./embedded-agent-live.runtime.js";
import {
  createWorkerTranscriptRuntime,
  toAgentMessage,
  toWorkerInferenceContext,
} from "./embedded-agent-transcript.runtime.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  toWorkerTranscriptMessage,
} from "./transcript-message.js";

const tinyVideo = { type: "video" as const, data: "Y2xpcA==", mimeType: "video/mp4" };

describe("worker native-video transcript boundaries", () => {
  it("preserves bounded video and text across both worker transcript adapters", () => {
    const message: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "What happens?" }, tinyVideo],
      timestamp: 1,
    };

    const projected = toWorkerTranscriptMessage(message);

    expect(projected).toEqual(message);
    expect(projected && toAgentMessage(projected)).toEqual(message);
    expect(projected && isWorkerTranscriptMessageFrameSafe(projected)).toBe(true);
  });

  it("replaces oversized transcript clips with visible text while preserving the question", () => {
    const message: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "What happens?" },
        { ...tinyVideo, data: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) },
      ],
      timestamp: 1,
    };

    const projected = toWorkerTranscriptMessage(message);

    expect(projected).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What happens?" },
        {
          type: "text",
          text: "(video omitted: attachment exceeds the cloud-worker transcript payload limit)",
        },
      ],
      timestamp: 1,
    });
    expect(projected && isWorkerTranscriptMessageFrameSafe(projected)).toBe(true);
  });

  it("makes durable-reference-only video visible without trusting worker media metadata", () => {
    const message = {
      role: "user" as const,
      content: "What happens?",
      timestamp: 1,
      __openclaw: {
        media: [{ kind: "video" as const, url: "media://inbound/clip.mp4" }],
      },
    };

    expect(toWorkerTranscriptMessage(message)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What happens?" },
        {
          type: "text",
          text: "(video omitted: attachment is unavailable to the cloud worker)",
        },
      ],
      timestamp: 1,
    });
  });

  it("keeps the larger inference payload limit independent of transcript commits", () => {
    const video = { ...tinyVideo, data: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES + 1) };

    expect(
      toWorkerInferenceContext({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What happens?" }, video],
            timestamp: 1,
          },
        ],
      }),
    ).toEqual({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What happens?" }, video],
          timestamp: 1,
        },
      ],
    });
  });

  it("replaces inference clips that exceed the existing protocol limit", () => {
    const video = {
      ...tinyVideo,
      data: "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES),
    };

    expect(
      toWorkerInferenceContext({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What happens?" }, video],
            timestamp: 1,
          },
        ],
      }),
    ).toEqual({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What happens?" },
            {
              type: "text",
              text: "(video omitted: attachment exceeds the cloud-worker inference payload limit)",
            },
          ],
          timestamp: 1,
        },
      ],
    });
  });

  it("commits an oversized local-tool clip as a bounded visible omission", async () => {
    const commit = vi.fn(async () => undefined);
    const runtime = createWorkerTranscriptRuntime({ commit });

    runtime.onMessagePersisted({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [
        { type: "text", text: "Clip captured." },
        { ...tinyVideo, data: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) },
      ],
      isError: false,
      timestamp: 1,
    });
    await runtime.withSessionWriteLock(() => undefined);

    expect(commit).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "toolResult",
        content: [
          { type: "text", text: "Clip captured." },
          {
            type: "text",
            text: "(video omitted: attachment exceeds the cloud-worker transcript payload limit)",
          },
        ],
      }),
    ]);
  });

  it("redacts native video bytes from every worker tool live-event phase", async () => {
    const emit = vi.fn(async (_event: WorkerLiveEvent) => undefined);
    const runtime = createWorkerLiveRuntime({ emit });
    const media = { ...tinyVideo, data: "c2Vuc2l0aXZlLXZpZGVvLWJ5dGVz" };
    const identity = { toolCallId: "call-1", toolName: "read" };

    runtime.handleSessionEvent({ type: "tool_execution_start", ...identity, args: { media } });
    runtime.handleSessionEvent({
      type: "tool_execution_update",
      ...identity,
      args: {},
      partialResult: { media },
    });
    runtime.handleSessionEvent({
      type: "tool_execution_end",
      ...identity,
      isError: false,
      result: { media },
    });
    await runtime.flush();

    expect(emit).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(media.data);
    for (const [event] of emit.mock.calls) {
      if (event.kind !== "tool") {
        throw new Error("expected a worker tool live event");
      }
      const value =
        event.payload.phase === "start"
          ? event.payload.args
          : event.payload.phase === "update"
            ? event.payload.partialResult
            : event.payload.result;
      expect(value).toEqual({
        media: expect.objectContaining({ type: "video", data: "<redacted>" }),
      });
    }
  });
});
