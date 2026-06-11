import { describe, expect, it } from "vitest";
import { __testing, resolvePatternLabYoutubeRoot } from "./pattern-lab-dashboard-data.js";

describe("Pattern Lab dashboard data helpers", () => {
  it("resolves the repo-local youtube-v1 command center", () => {
    expect(resolvePatternLabYoutubeRoot()).toMatch(/openclaw\/youtube-v1$/);
  });

  it("checks ancestor layouts so promoted gateway snapshots can find repo-local Pattern Lab files", () => {
    expect(
      __testing
        .collectPatternLabYoutubeRootCandidates()
        .some((candidate) => candidate.endsWith("openclaw/youtube-v1")),
    ).toBe(true);
  });

  it("keeps missing-root errors actionable without leaking checked absolute paths", () => {
    const message = __testing.patternLabYoutubeRootMissingMessage();

    expect(message).toContain("OPENCLAW_PATTERN_LAB_YOUTUBE_ROOT");
    expect(message).toContain("OpenClaw repo root");
    expect(message).not.toContain("/Users/");
  });

  it("parses quoted CSV rows for rights-ledger values", () => {
    expect(
      __testing.parseCsv(
        [
          "asset_id,asset_type,notes,human_review_status",
          'image_001,image,"specific, artifact-backed visual",approved',
        ].join("\n"),
      ),
    ).toEqual({
      headers: ["asset_id", "asset_type", "notes", "human_review_status"],
      rows: [
        {
          asset_id: "image_001",
          asset_type: "image",
          notes: "specific, artifact-backed visual",
          human_review_status: "approved",
        },
      ],
    });
  });

  it("summarizes approval state by asset group", () => {
    const summary = __testing.approvalSummary([
      { asset_type: "thumbnail", human_review_status: "approved" },
      { asset_type: "thumbnail", human_review_status: "pending" },
      { asset_type: "short", human_review_status: "approved" },
    ]);

    expect(summary.thumbnail).toEqual({
      total: 2,
      approved: 1,
      pending: 1,
      complete: false,
    });
    expect(summary.short).toEqual({
      total: 1,
      approved: 1,
      pending: 0,
      complete: true,
    });
    expect(summary.voiceover.complete).toBe(false);
  });

  it("matches item-level review decisions by asset id and filename", () => {
    const row = {
      asset_id: "video-01-short-01",
      asset_type: "short",
      filename: "shorts/pattern-lab-video-01-short-01.mp4",
    };

    expect(
      __testing.rowMatchesAssetDecision(row, {
        action: "approve",
        assetType: "short",
        assetId: "video-01-short-01",
      }),
    ).toBe(true);
    expect(
      __testing.rowMatchesAssetDecision(row, {
        action: "approve",
        assetType: "short",
        filename: "shorts/pattern-lab-video-01-short-01.mp4",
      }),
    ).toBe(true);
    expect(
      __testing.rowMatchesAssetDecision(row, {
        action: "approve",
        assetType: "short",
        assetId: "video-01-short-02",
      }),
    ).toBe(false);
  });

  it("maps review actions to durable ledger statuses", () => {
    expect(__testing.reviewStatusForAction("approve")).toBe("approved");
    expect(__testing.reviewStatusForAction("reject")).toBe("rejected");
    expect(__testing.reviewStatusForAction("regenerate")).toBe("regeneration_requested");
    expect(__testing.reviewStatusForAction("repair")).toBe("repair_requested");
  });

  it("normalizes only local Pattern Lab media paths", () => {
    expect(
      __testing.normalizeMediaPath("local-output/video-01/images/thumbnail_candidate_a.png"),
    ).toBe("local-output/video-01/images/thumbnail_candidate_a.png");
    expect(
      __testing.normalizeMediaPath("local-output/video-01/video/pattern-lab-video-01-draft.mp4"),
    ).toBe("local-output/video-01/video/pattern-lab-video-01-draft.mp4");

    expect(__testing.normalizeMediaPath("../youtube-v1/local-output/video-01/x.png")).toBeNull();
    expect(__testing.normalizeMediaPath("/local-output/video-01/x.png")).toBeNull();
    expect(__testing.normalizeMediaPath("launch/video-01/final-script.md")).toBeNull();
  });
});
