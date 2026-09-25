import { beforeEach, describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  sanitizeAssistantVisibleText,
  stripAssistantInternalScaffolding,
} from "../../shared/text/assistant-visible-text.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { normalizeReplyPayload } from "./normalize-reply.js";

function buildTestReplyPayloads({ payloads }: { payloads: ReplyPayload[] }) {
  return buildReplyPayloads({
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    replyToMode: "off",
    payloads,
  });
}

describe("tool failure reply delivery", () => {
  beforeEach(() => resetPluginRuntimeStateForTest());

  it.each([false, true])(
    "preserves the model's tool-failure explanation through repeated delivery normalization (heartbeat: %s)",
    async (isHeartbeat) => {
      const explanation =
        "The lookup failed because Slack received too many requests and asked for a one-second wait before retrying. " +
        "No retry was made, as instructed, so the lookup remains incomplete.";
      const payloads = buildEmbeddedRunPayloads({
        assistantTexts: [explanation],
        lastAssistant: undefined,
        lastToolError: { toolName: "slack_read_thread", error: "429 Too Many Requests" },
        toolFailureExplanation: true,
        sessionKey: "agent:main:tool-failure",
      });
      const { replyPayloads } = await buildReplyPayloads({
        isHeartbeat,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "off",
        payloads,
      });
      const delivered = replyPayloads.map((payload) => normalizeReplyPayload(payload));

      expect(delivered).toEqual([expect.objectContaining({ text: explanation, isError: true })]);
      expect(getReplyPayloadMetadata(delivered[0]!)).toMatchObject({
        toolFailureExplanation: true,
      });
      expect(normalizeReplyPayload(delivered[0]!)).toMatchObject({
        text: explanation,
        isError: true,
      });
    },
  );

  it("keeps the existing rate-limit copy for a model-provider failure", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "429 Too Many Requests", isError: true }],
    });

    expect(replyPayloads.map((payload) => normalizeReplyPayload(payload))).toEqual([
      expect.objectContaining({
        text: "⚠️ API rate limit reached. Please try again later.",
        isError: true,
      }),
    ]);
  });

  it.each(["exec", "bash"])(
    "honors a completed silent answer after a %s failure",
    async (toolName) => {
      const payloads = buildEmbeddedRunPayloads({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: undefined,
        lastToolError: { toolName, error: "Command not found", mutatingAction: true },
        sessionKey: "agent:main:warning",
      });
      const { replyPayloads } = await buildTestReplyPayloads({ payloads });

      expect(replyPayloads).toEqual([]);
    },
  );

  it.each(["exec", "bash"])(
    "delivers the %s failure fallback when the agent produced no answer",
    async (toolName) => {
      const payloads = buildEmbeddedRunPayloads({
        assistantTexts: [],
        lastAssistant: undefined,
        lastToolError: { toolName, error: "Command not found" },
        sessionKey: "agent:main:warning",
      });
      const { replyPayloads } = await buildTestReplyPayloads({ payloads });
      const delivered = replyPayloads
        .map((payload) => normalizeReplyPayload(payload))
        .filter(Boolean);

      expect(delivered).toEqual([
        expect.objectContaining({
          text: `The ${toolName === "exec" ? "Exec" : "Bash"} step failed`,
          isError: true,
        }),
      ]);
      // Both channel text cleanup and Control UI display must retain the warning.
      expect(sanitizeAssistantVisibleText(delivered[0]?.text ?? "")).toBe(delivered[0]?.text);
      expect(stripAssistantInternalScaffolding(delivered[0]?.text ?? "")).toBe(delivered[0]?.text);
      expect(
        normalizeReplyPayload({
          text: `⚠️ 🛠️ ${toolName === "exec" ? "Exec" : "Bash"} failed`,
          isError: true,
        }),
      ).toBeNull();
    },
  );
});
