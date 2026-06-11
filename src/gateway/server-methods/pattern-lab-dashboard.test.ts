import { describe, expect, it, vi } from "vitest";
import type { PatternLabDashboardSnapshot } from "../pattern-lab-dashboard-data.js";
import { createPatternLabDashboardHandlers } from "./pattern-lab-dashboard.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./types.js";

function snapshot(patch: Partial<PatternLabDashboardSnapshot> = {}): PatternLabDashboardSnapshot {
  return {
    generatedAt: "2026-05-11T20:00:00Z",
    videoId: "01",
    channelName: "Pattern Lab",
    status: "owner-review-required",
    publicPublish: "blocked_until_explicit_owner_approval",
    outputRoot: "youtube-v1/local-output/video-01",
    approvals: {
      image: { total: 1, approved: 1, pending: 0, complete: true },
      thumbnail: { total: 2, approved: 1, pending: 1, complete: false },
      voiceover: { total: 1, approved: 0, pending: 1, complete: false },
      proof_footage: { total: 1, approved: 1, pending: 0, complete: true },
      video: { total: 1, approved: 0, pending: 1, complete: false },
      short: { total: 3, approved: 0, pending: 3, complete: false },
    },
    blockers: ["Human review approval is missing for asset type: thumbnail."],
    readinessSteps: [],
    media: {
      longForm: file("video/pattern-lab-video-01-draft.mp4"),
      voiceover: file("audio/voiceover_full_normalized.mp3"),
      shorts: [],
      thumbnails: [],
      reviewPacket: file("review/owner-review-packet.md"),
      readinessReport: file("approval/private-upload-readiness.md"),
    },
    performance: {
      path: "local-output/video-01/metrics/video-01-performance.csv",
      repoPath: "youtube-v1/local-output/video-01/metrics/video-01-performance.csv",
      rows: [],
      cards: [],
      decisionLabel: "pending_publish",
      nextAction: "Review package.",
      commentsSignalSummary: "",
      requiredExports: [],
      decisionLabels: ["double_down"],
    },
    nextActions: ["Review package."],
    ...patch,
  };
}

function file(relativePath: string) {
  return {
    path: `local-output/video-01/${relativePath}`,
    repoPath: `youtube-v1/local-output/video-01/${relativePath}`,
    mediaPath: `local-output/video-01/${relativePath}`,
    mediaUrl: `/__openclaw__/pattern-lab-media?path=${encodeURIComponent(
      `local-output/video-01/${relativePath}`,
    )}`,
    exists: true,
    sizeBytes: 1024,
    durationSeconds: null,
  };
}

async function call(handler: GatewayRequestHandler, params: Record<string, unknown>) {
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: "1", method: "patternLab.dashboard.snapshot" },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as GatewayRequestContext,
  });
  return respond;
}

describe("Pattern Lab dashboard gateway methods", () => {
  it("responds with a dashboard snapshot", async () => {
    const loadSnapshot = vi.fn(async () => snapshot());
    const handlers = createPatternLabDashboardHandlers({ loadSnapshot });

    const respond = await call(handlers["patternLab.dashboard.snapshot"], { videoId: "01" });

    expect(loadSnapshot).toHaveBeenCalledWith({ videoId: "01" });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ channelName: "Pattern Lab" }),
    );
  });

  it("approves a specific asset group and returns a fresh snapshot", async () => {
    const approveAssetType = vi.fn(async () => snapshot({ status: "private-upload-ready" }));
    const handlers = createPatternLabDashboardHandlers({ approveAssetType });

    const respond = await call(handlers["patternLab.assets.approve"], {
      videoId: "01",
      assetType: "thumbnail",
    });

    expect(approveAssetType).toHaveBeenCalledWith({ videoId: "01", assetType: "thumbnail" });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "private-upload-ready" }),
    );
  });

  it("fails closed for unsupported asset approval requests", async () => {
    const approveAssetType = vi.fn();
    const handlers = createPatternLabDashboardHandlers({ approveAssetType });

    const respond = await call(handlers["patternLab.assets.approve"], {
      videoId: "01",
      assetType: "script",
    });

    expect(approveAssetType).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
