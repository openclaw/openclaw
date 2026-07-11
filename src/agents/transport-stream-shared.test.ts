// Transport stream shared tests cover payload sanitization, header merging, and
// final/error stream termination helpers used by provider transports.
import { describe, expect, it, vi } from "vitest";
import type { ServerRetryAfter } from "../llm/types.js";
import { resolveAutoRetryDelayMs } from "../llm/utils/retry.js";
import {
  assignTransportErrorDetails,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

describe("transport stream shared helpers", () => {
  it("propagates httpStatus and retryAfter from an augmented transport error", () => {
    const output: {
      stopReason: string;
      errorMessage?: string;
      httpStatus?: number;
      retryAfter?: ServerRetryAfter;
    } = { stopReason: "stop" };
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      retryAfter: { kind: "seconds", seconds: 30 },
    });

    assignTransportErrorDetails(output as never, error);

    expect(output.stopReason).toBe("error");
    expect(output.httpStatus).toBe(429);
    expect(output.retryAfter).toEqual({ kind: "seconds", seconds: 30 });
  });

  it("omits status/retry-after fields when the error carries none", () => {
    const output: { stopReason: string; httpStatus?: number; retryAfter?: ServerRetryAfter } = {
      stopReason: "stop",
    };

    assignTransportErrorDetails(output as never, new Error("boom"));

    expect(output.httpStatus).toBeUndefined();
    expect(output.retryAfter).toBeUndefined();
  });

  it("preserves an over-limit (unbounded) retryAfter through extraction so it can be rejected", () => {
    // parseRetryAfterSeconds yields Infinity for an overflowed numeric header;
    // that over-limit signal becomes { kind: "unbounded" } so it must survive so
    // the resolver rejects it instead of falling back to the short exponential delay.
    const output: { stopReason: string; retryAfter?: ServerRetryAfter } = { stopReason: "stop" };
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      retryAfter: { kind: "unbounded" },
    });

    assignTransportErrorDetails(output as never, error);

    expect(output.retryAfter).toEqual({ kind: "unbounded" });
    // End of chain: the resolver rejects an over-limit cooldown (stop retrying).
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        maxRetryDelayMs: 60_000,
        retryAfter: output.retryAfter,
      }),
    ).toBeNull();
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
