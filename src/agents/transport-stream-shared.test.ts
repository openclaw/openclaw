import {
  failTransportStream,
  mergeTransportHeaders,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "@openclaw/ai/transports";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { classifyAssistantFailoverReason } from "./embedded-agent-helpers.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

function createTransportOutput() {
  return makeAssistantMessageFixture({ stopReason: "stop", content: [] });
}

function projectFailure(output: ReturnType<typeof createTransportOutput>, error: unknown): void {
  failTransportStream({
    stream: { push: () => {}, end: () => {} },
    output,
    error,
  });
}

describe("transport stream shared helpers", () => {
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
      const output = createTransportOutput();

      expect(() => projectFailure(output, error)).not.toThrow();
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
    const output = makeAssistantMessageFixture({ stopReason: "stop", content: [] });

    projectFailure(output, sdkError);

    expect(output.errorCode).toBe("ECONNREFUSED");
    expect(classifyAssistantFailoverReason(output)).toBe("timeout");
  });
});
