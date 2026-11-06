import { describe, expect, it } from "vitest";
import { ProviderHttpError } from "../agents/provider-http-errors.js";
import { formatMediaFailureReason, formatMediaFailureSummary } from "./media-failure-reason.js";
import { summarizeDecisionReason } from "./runner.entries.js";

function providerFailure(
  message: string,
  params: { status: number; code?: string; requestId?: string },
) {
  return new ProviderHttpError(message, params);
}

describe("media failure reason helpers", () => {
  it("summarizes a provider failure with status and code only", () => {
    const error = providerFailure(
      "Audio transcription failed (HTTP 429): tenant customer-42 is suspended [request_id=req_secret]",
      { status: 429, code: "insufficient_quota", requestId: "req_secret" },
    );

    expect(formatMediaFailureSummary(error)).toBe(
      "provider request failed (HTTP 429 code=insufficient_quota)",
    );
  });

  it("does not summarize arbitrary runtime errors", () => {
    expect(formatMediaFailureSummary(new Error("tenant customer-42 is suspended"))).toBeUndefined();
    expect(formatMediaFailureSummary("raw string failure")).toBeUndefined();
  });

  it("drops provider codes that are not a bounded taxonomy token", () => {
    const error = providerFailure("Transcription failed (HTTP 400)", {
      status: 400,
      code: "tenant customer-42 is suspended",
    });

    expect(formatMediaFailureSummary(error)).toBe("provider request failed (HTTP 400)");
  });

  it("keeps the code in the compact summary for an adapter-shaped message", () => {
    const error = providerFailure(
      "Audio transcription failed (HTTP 429): Quota exhausted [code=insufficient_quota]",
      { status: 429, code: "insufficient_quota", requestId: "req_abc" },
    );

    const reason = formatMediaFailureReason(error);

    expect(reason).toContain("Audio transcription failed (HTTP 429 code=insufficient_quota)");
    expect(reason).toContain("Quota exhausted");
    expect(reason).toContain("[request_id=req_abc]");
    expect(summarizeDecisionReason(reason)).toBe(
      "Audio transcription failed (HTTP 429 code=insufficient_quota)",
    );
  });

  it("keeps the code inside the compact summary budget when detail is long", () => {
    const detail = "x".repeat(180);
    const error = providerFailure(`Transcription failed (HTTP 429): ${detail}`, {
      status: 429,
      code: "insufficient_quota",
    });

    const compact = summarizeDecisionReason(formatMediaFailureReason(error));

    expect(compact).toBe("Transcription failed (HTTP 429 code=insufficient_quota)");
    expect(compact).not.toContain("x".repeat(10));
  });
});
