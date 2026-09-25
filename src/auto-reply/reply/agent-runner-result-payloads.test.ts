import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../types.js";
import { captureDiagnosticResponse } from "./diagnostic-response-capture.js";

// Mirrors the private per-field budget in src/infra/diagnostic-content.ts; the
// production constant stays unexported because only tests would consume it.
const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;

function payload(
  text: string | undefined,
  flags: Pick<ReplyPayload, "isReasoning" | "isCommentary"> = {},
): ReplyPayload {
  return { text, ...flags } as ReplyPayload;
}

describe("captureDiagnosticResponse", () => {
  it("joins visible payload texts and excludes reasoning and commentary", () => {
    expect(
      captureDiagnosticResponse([
        payload("first answer"),
        payload("internal reasoning", { isReasoning: true }),
        payload("status notice", { isCommentary: true }),
        payload("second answer"),
      ]),
    ).toBe("first answer\nsecond answer");
  });

  it("skips blank and empty payload texts", () => {
    expect(captureDiagnosticResponse([payload("   "), payload(undefined), payload("kept")])).toBe(
      "kept",
    );
  });

  it("returns undefined when no payload carries visible text", () => {
    expect(
      captureDiagnosticResponse([payload("reasoning", { isReasoning: true }), payload("   ")]),
    ).toBeUndefined();
  });

  it("bounds the joined response to the diagnostic content budget", () => {
    const oversized = `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 1)}🚀tail`;
    const captured = captureDiagnosticResponse([payload(oversized), payload("dropped tail")]);
    expect(captured).toBeDefined();
    expect(captured?.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
    expect(captured?.endsWith("…[truncated]")).toBe(true);
  });
});
