import {
  approvePatternLabAssetType,
  loadPatternLabDashboardSnapshot,
  normalizePatternLabAssetType,
  normalizePatternLabVideoId,
  type PatternLabAssetType,
  type PatternLabDashboardSnapshot,
} from "../pattern-lab-dashboard-data.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type LoadSnapshot = (params?: { videoId?: unknown }) => Promise<PatternLabDashboardSnapshot>;
type ApproveAssetType = (params: {
  assetType: PatternLabAssetType;
  videoId?: unknown;
}) => Promise<PatternLabDashboardSnapshot>;

export function createPatternLabDashboardHandlers(params?: {
  loadSnapshot?: LoadSnapshot;
  approveAssetType?: ApproveAssetType;
}): GatewayRequestHandlers {
  const loadSnapshot = params?.loadSnapshot ?? loadPatternLabDashboardSnapshot;
  const approveAssetType = params?.approveAssetType ?? approvePatternLabAssetType;
  return {
    "patternLab.dashboard.snapshot": async ({ params: requestParams, respond }) => {
      try {
        const snapshot = await loadSnapshot({
          videoId: normalizePatternLabVideoId(requestParams.videoId),
        });
        respond(true, snapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Pattern Lab dashboard unavailable: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "patternLab.assets.approve": async ({ params: requestParams, respond }) => {
      try {
        const assetType = normalizePatternLabAssetType(requestParams.assetType);
        const snapshot = await approveAssetType({
          assetType,
          videoId: normalizePatternLabVideoId(requestParams.videoId),
        });
        respond(true, snapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Pattern Lab asset approval failed: ${message}`),
        );
      }
    },
  };
}

export const patternLabDashboardHandlers = createPatternLabDashboardHandlers();
