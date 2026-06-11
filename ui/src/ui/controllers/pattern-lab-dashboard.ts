import type { GatewayBrowserClient } from "../gateway.ts";

export type PatternLabAssetType =
  | "image"
  | "thumbnail"
  | "voiceover"
  | "proof_footage"
  | "video"
  | "short";

export type PatternLabFileInfo = {
  path: string;
  repoPath: string;
  mediaPath: string;
  mediaUrl: string;
  exists: boolean;
  sizeBytes: number;
  durationSeconds: number | null;
};

export type PatternLabApprovalSummary = {
  total: number;
  approved: number;
  pending: number;
  complete: boolean;
};

export type PatternLabPerformanceCard = {
  label: string;
  value: string;
  why: string;
};

export type PatternLabDashboardSnapshot = {
  generatedAt: string;
  videoId: string;
  channelName: string;
  status: "owner-review-required" | "private-upload-ready";
  publicPublish: "blocked_until_explicit_owner_approval";
  outputRoot: string;
  approvals: Record<PatternLabAssetType, PatternLabApprovalSummary>;
  blockers: string[];
  readinessSteps: Array<{
    label: string;
    complete: boolean;
    detail: string;
  }>;
  media: {
    longForm: PatternLabFileInfo;
    voiceover: PatternLabFileInfo;
    shorts: PatternLabFileInfo[];
    thumbnails: PatternLabFileInfo[];
    reviewPacket: PatternLabFileInfo;
    readinessReport: PatternLabFileInfo;
  };
  performance: {
    path: string;
    repoPath: string;
    rows: Record<string, string>[];
    cards: PatternLabPerformanceCard[];
    decisionLabel: string;
    nextAction: string;
    commentsSignalSummary: string;
    requiredExports: string[];
    decisionLabels: string[];
  };
  nextActions: string[];
};

export type PatternLabDashboardState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  patternLabDashboardLoading: boolean;
  patternLabDashboardError: string | null;
  patternLabDashboard: PatternLabDashboardSnapshot | null;
  patternLabDashboardLastFetchAt: number | null;
  patternLabApprovalBusy: PatternLabAssetType | null;
  requestUpdate?: () => void;
};

export async function loadPatternLabDashboard(
  state: PatternLabDashboardState,
  opts?: { quiet?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (!opts?.quiet) {
    state.patternLabDashboardLoading = true;
  }
  state.patternLabDashboardError = null;
  state.requestUpdate?.();
  try {
    const snapshot = await state.client.request<PatternLabDashboardSnapshot>(
      "patternLab.dashboard.snapshot",
      { videoId: "01" },
    );
    state.patternLabDashboard = snapshot;
    state.patternLabDashboardLastFetchAt = Date.now();
  } catch (error) {
    state.patternLabDashboardError = error instanceof Error ? error.message : String(error);
  } finally {
    state.patternLabDashboardLoading = false;
    state.requestUpdate?.();
  }
}

export async function approvePatternLabAssetType(
  state: PatternLabDashboardState,
  assetType: PatternLabAssetType,
) {
  if (!state.client || !state.connected || state.patternLabApprovalBusy) {
    return;
  }
  state.patternLabApprovalBusy = assetType;
  state.patternLabDashboardError = null;
  state.requestUpdate?.();
  try {
    const snapshot = await state.client.request<PatternLabDashboardSnapshot>(
      "patternLab.assets.approve",
      { videoId: "01", assetType },
    );
    state.patternLabDashboard = snapshot;
    state.patternLabDashboardLastFetchAt = Date.now();
  } catch (error) {
    state.patternLabDashboardError = error instanceof Error ? error.message : String(error);
  } finally {
    state.patternLabApprovalBusy = null;
    state.requestUpdate?.();
  }
}
