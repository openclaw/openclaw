import {
  assignTransportErrorDetails,
  failTransportStream,
  mergeTransportHeaders,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "@openclaw/ai/transports";
import OpenAI from "openai";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { normalizeTranscriptJsonValue } from "../config/sessions/transcript-json.js";
import { classifyAssistantFailoverReason } from "./embedded-agent-helpers/assistant-message-failures.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

function projectFailure(error: unknown) {
  const output = makeAssistantMessageFixture({ stopReason: "stop", content: [] });
  failTransportStream({ stream: { push: () => {}, end: () => {} }, output, error });
  return output;
}

describe("transport stream shared helpers", () => {
  it.each([
    ["makeAssistantMessageFixture", makeAssistantMessageFixture],
    ["makeAgentAssistantMessage", makeAgentAssistantMessage],
  ] as const)("%s owns usage across transcript and transport lifetimes", (_name, builder) => {
    const buildMessage = (usage?: AssistantMessage["usage"]) =>
      builder({ content: [], ...(usage ? { usage } : {}) });
    const stored = buildMessage();
    normalizeTranscriptJsonValue({ message: stored }, "entry");

    const transport = buildMessage();
    expect(transport.usage).toEqual(createZeroUsageFixture());
    expect(transport.usage).not.toBe(stored.usage);
    expect(transport.usage.cost).not.toBe(stored.usage.cost);
    expect(Object.isExtensible(transport.usage)).toBe(true);
    expect(Object.isExtensible(transport.usage.cost)).toBe(true);

    assignTransportErrorDetails(transport, new Error("fixture failure"));
    expect(transport.usage.usageReport).toEqual({ state: "unavailable" });
    expect(transport.usage.contextUsage).toEqual({ state: "unavailable" });

    const explicitUsage = createZeroUsageFixture();
    expect(buildMessage(explicitUsage).usage).toBe(explicitUsage);
  });

  it("returns empty string for nullish payloads instead of throwing", () => {
    expect(sanitizeTransportPayloadText(undefined as unknown as string)).toBe("");
    expect(sanitizeTransportPayloadText(null as unknown as string)).toBe("");
    expect(sanitizeNonEmptyTransportPayloadText(undefined as unknown as string)).toBe(
      "(no output)",
    );
  });

  it("merges transport headers in source order", () => {
    expect(
      mergeTransportHeaders(
        { accept: "text/event-stream", "user-agent": "configured", "x-base": "one" },
        { authorization: "Bearer token" },
        { "User-Agent": "openclaw/2026.9.1", "x-base": "two" },
      ),
    ).toEqual({
      accept: "text/event-stream",
      authorization: "Bearer token",
      "User-Agent": "openclaw/2026.9.1",
      "x-base": "two",
    });
    expect(mergeTransportHeaders(undefined, undefined)).toBeUndefined();
  });

  it("does not throw while recording non-JSON transport rejections", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const error of [1n, circular]) {
      const output = projectFailure(error);
      expect(output.stopReason).toBe("error");
      expect(output.errorMessage).toBeTruthy();
    }
  });

  it("extracts Undici codes through the OpenAI SDK error wrapper", () => {
    const socketError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:65534"), {
      code: "ECONNREFUSED",
    });
    const fetchError = new TypeError("fetch failed", { cause: socketError });
    const sdkError = new OpenAI.APIConnectionError({ cause: fetchError });
    const output = projectFailure(sdkError);

    expect(output.errorCode).toBe("ECONNREFUSED");
    expect(classifyAssistantFailoverReason(output)).toBe("timeout");
  });
});
