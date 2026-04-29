import { describe, expect, it, vi } from "vitest";
import {
  coerceTransportToolCallArguments,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

describe("coerceTransportToolCallArguments", () => {
  it("parses JSON-string arguments in default mode", () => {
    expect(coerceTransportToolCallArguments('{"path":"README.md"}', { mode: "off" })).toEqual({
      path: "README.md",
    });
  });

  it("emits a warn-mode repair event when JSON-string arguments are parsed", () => {
    const repairs: unknown[] = [];
    expect(
      coerceTransportToolCallArguments('{"path":"README.md"}', {
        mode: "warn",
        onRepairEvent: (event) => repairs.push(event),
      }),
    ).toEqual({ path: "README.md" });
    expect(repairs).toEqual([
      {
        kind: "argumentShapeRepair",
        fromType: "string",
        toType: "object",
        mode: "warn",
        detail: "json-parse",
      },
    ]);
  });

  it("rejects JSON-string arguments in strict mode", () => {
    expect(() =>
      coerceTransportToolCallArguments('{"path":"README.md"}', { mode: "strict" }),
    ).toThrow("strict tool mode rejected non-object tool arguments");
  });

  it("rejects malformed arguments in strict mode", () => {
    expect(() => coerceTransportToolCallArguments("not-json", { mode: "strict" })).toThrow(
      "strict tool mode rejected non-object tool arguments",
    );
  });
});

describe("transport stream shared helpers", () => {
  it("sanitizes unpaired surrogate code units", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);

    expect(sanitizeTransportPayloadText(`left${high}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText(`left${low}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText("emoji 🙈 ok")).toBe("emoji 🙈 ok");
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
});
