// Runner entry guard tests cover malformed decision data formatting without
// depending on provider execution.
import { describe, expect, it } from "vitest";
import { formatDecisionSummary, formatMissingProviderHint } from "./runner.entries.js";
import type { MediaUnderstandingDecision } from "./types.js";

describe("media-understanding formatDecisionSummary guards", () => {
  it("formats skipped summary when decision.attachments is undefined", () => {
    expect(
      formatDecisionSummary({
        capability: "image",
        outcome: "skipped",
        attachments: undefined as unknown as MediaUnderstandingDecision["attachments"],
      }),
    ).toBe("image: skipped");
  });

  it("counts malformed attachment attempts as unchosen", () => {
    expect(
      formatDecisionSummary({
        capability: "video",
        outcome: "skipped",
        attachments: [{ attachmentIndex: 0, attempts: { bad: true } }],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("video: skipped (0/1)");
  });

  it("ignores non-string provider/model/reason fields", () => {
    expect(
      formatDecisionSummary({
        capability: "audio",
        outcome: "failed",
        attachments: [
          {
            attachmentIndex: 0,
            chosen: {
              outcome: "failed",
              provider: { bad: true },
              model: 42,
            },
            attempts: [{ reason: { malformed: true } }],
          },
        ],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("audio: failed (0/1)");
  });
});

describe("media-understanding formatMissingProviderHint", () => {
  it("returns the catalog hint for a known externalized provider (amazon-bedrock)", () => {
    const hint = formatMissingProviderHint("amazon-bedrock");
    expect(hint).toContain("openclaw plugins install @openclaw/amazon-bedrock-provider");
    expect(hint).toContain("openclaw plugins registry --refresh");
    expect(hint).toContain("restart the gateway");
    expect(hint).toContain("openclaw doctor --fix");
    expect(hint).toContain("official external plugin");
  });

  it("returns empty string for a non-cataloged id (no convention fallback)", () => {
    // Newly externalized providers must register with the official external
    // catalog to receive an actionable hint; the previous convention
    // fallback (`@openclaw/<id>-provider`) was removed to avoid emitting
    // misleading package hints for non-externalized ids.
    const hint = formatMissingProviderHint("mystery-provider");
    expect(hint).toBe("");
  });

  it("returns empty string for an empty/whitespace id", () => {
    expect(formatMissingProviderHint("")).toBe("");
    expect(formatMissingProviderHint("   ")).toBe("");
  });

  it("returns empty string for an id that does not look like a plugin id", () => {
    expect(formatMissingProviderHint("bad/id")).toBe("");
    expect(formatMissingProviderHint("a")).toBe("");
    // Multi-segment path with slash is not a plugin id.
    expect(formatMissingProviderHint("some/long/path")).toBe("");
  });

  it("produces a hint suffix that, when appended to the legacy message, preserves the legacy prefix (catalog-known id)", () => {
    const providerId = "amazon-bedrock";
    const legacyPrefix = `Media provider not available: ${providerId}`;
    const hint = formatMissingProviderHint(providerId);
    const composed = `${legacyPrefix}${hint}`;
    expect(composed).toMatch(
      /^Media provider not available: amazon-bedrock .*openclaw plugins install/,
    );
    // Tier 1 includes the "official" prefix in the wording.
    expect(composed).toMatch(/official external plugin/);
    // Tier 1 also includes the gateway restart step.
    expect(composed).toMatch(/restart the gateway/);
  });

  it("returns a hint that preserves the legacy prefix verbatim when the id is not cataloged", () => {
    const providerId = "mystery-provider";
    const legacyPrefix = `Media provider not available: ${providerId}`;
    const hint = formatMissingProviderHint(providerId);
    // No fallback; the legacy prefix is preserved exactly.
    expect(`${legacyPrefix}${hint}`).toBe(legacyPrefix);
  });

  it("returns empty string for an id that is only in the channel catalog (feishu) — prevents misleading install hints", () => {
    // Feishu is an official external channel (not a media provider), so the
    // provider-only lookup must skip it. Otherwise a media-provider error
    // would emit `openclaw plugins install @openclaw/feishu` which is not
    // the package that owns the missing media surface.
    expect(formatMissingProviderHint("feishu")).toBe("");
  });
});
