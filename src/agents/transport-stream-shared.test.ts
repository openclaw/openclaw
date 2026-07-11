// Transport stream shared tests cover payload sanitization, header merging, and
// final/error stream termination helpers used by provider transports.
import { describe, expect, it, vi } from "vitest";
import {
  assignTransportErrorDetails,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  parseTransportRetryAfterSeconds,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

describe("transport stream shared helpers", () => {
  it("propagates httpStatus and retryAfterSeconds from an augmented transport error", () => {
    const output: {
      stopReason: string;
      errorMessage?: string;
      httpStatus?: number;
      retryAfterSeconds?: number;
    } = { stopReason: "stop" };
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      retryAfterSeconds: 30,
    });

    assignTransportErrorDetails(output as never, error);

    expect(output.stopReason).toBe("error");
    expect(output.httpStatus).toBe(429);
    expect(output.retryAfterSeconds).toBe(30);
  });

  it("omits status/retry-after fields when the error carries none", () => {
    const output: { stopReason: string; httpStatus?: number; retryAfterSeconds?: number } = {
      stopReason: "stop",
    };

    assignTransportErrorDetails(output as never, new Error("boom"));

    expect(output.httpStatus).toBeUndefined();
    expect(output.retryAfterSeconds).toBeUndefined();
  });

  it("parses Retry-After from delta-seconds, retry-after-ms, and HTTP-date forms", () => {
    expect(parseTransportRetryAfterSeconds(new Headers({ "retry-after": "30" }))).toBe(30);
    expect(parseTransportRetryAfterSeconds(new Headers({ "retry-after-ms": "1500" }))).toBe(1.5);
    expect(parseTransportRetryAfterSeconds(new Headers())).toBeUndefined();

    const future = new Date(Date.now() + 45_000).toUTCString();
    const seconds = parseTransportRetryAfterSeconds(new Headers({ "retry-after": future }));
    expect(seconds).toBeGreaterThan(40);
    expect(seconds).toBeLessThanOrEqual(45);
  });

  it("sanitizes unpaired surrogate code units", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);

    expect(sanitizeTransportPayloadText(`left${high}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText(`left${low}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText("emoji 🙈 ok")).toBe("emoji 🙈 ok");
  });

  it("returns empty string for nullish payloads instead of throwing", () => {
    expect(sanitizeTransportPayloadText(undefined as unknown as string)).toBe("");
    expect(sanitizeTransportPayloadText(null as unknown as string)).toBe("");
    expect(sanitizeNonEmptyTransportPayloadText(undefined as unknown as string)).toBe(
      "(no output)",
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t "],
    ["invalid-surrogate-only", String.fromCharCode(0xd83d)],
  ])("falls back for %s tool payload text", (_label, value) => {
    expect(sanitizeNonEmptyTransportPayloadText(value)).toBe("(no output)");
  });

  it("preserves non-empty sanitized tool payload text", () => {
    expect(sanitizeNonEmptyTransportPayloadText(" ok ")).toBe(" ok ");
    expect(sanitizeNonEmptyTransportPayloadText(`left${String.fromCharCode(0xd83d)}right`)).toBe(
      "leftright",
    );
  });

  it("merges transport headers in source order", () => {
    expect(
      mergeTransportHeaders(
        { accept: "text/event-stream", "x-base": "one" },
        { authorization: "Bearer token" },
        { "x-base": "two" },
      ),
    ).toEqual({
      accept: "text/event-stream",
      authorization: "Bearer token",
      "x-base": "two",
    });
    expect(mergeTransportHeaders(undefined, undefined)).toBeUndefined();
  });

  it("finalizes successful transport streams", () => {
    const push = vi.fn();
    const end = vi.fn();
    const output = { stopReason: "stop" };

    finalizeTransportStream({
      stream: { push, end },
      output,
    });

    expect(push).toHaveBeenCalledWith({
      type: "done",
      reason: "stop",
      message: output,
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("marks transport stream failures and runs cleanup", () => {
    // Failure finalization mutates the output message before emitting it so
    // downstream transcript consumers see the same error state as the stream.
    const push = vi.fn();
    const end = vi.fn();
    const cleanup = vi.fn();
    const output: { stopReason: string; errorMessage?: string } = { stopReason: "stop" };

    failTransportStream({
      stream: { push, end },
      output,
      error: new Error("boom"),
      cleanup,
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toBe("boom");
    expect(push).toHaveBeenCalledWith({
      type: "error",
      reason: "error",
      error: output,
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("does not throw while recording non-JSON transport rejections", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const error of [1n, circular]) {
      const output: { stopReason: string; errorMessage?: string } = { stopReason: "stop" };

      expect(() => assignTransportErrorDetails(output, error)).not.toThrow();
      expect(output.stopReason).toBe("error");
      expect(output.errorMessage).toBeTruthy();
    }
  });
});
