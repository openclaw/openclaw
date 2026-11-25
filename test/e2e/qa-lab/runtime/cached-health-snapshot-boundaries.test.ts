import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCachedHealthSnapshotBoundariesProof,
  runHandlerBoundaryProof,
} from "./cached-health-snapshot-boundaries.js";

describe("cached health snapshot boundary producer", () => {
  it("proves deterministic cache reuse and invalidation boundaries", async () => {
    await expect(runHandlerBoundaryProof()).resolves.toEqual({
      cacheHitSameTimestamp: true,
      cachedMeta: true,
      passiveRefreshBounded: true,
      staleRefresh: true,
      explicitProbeRefresh: true,
      lifecycleMismatchRefresh: true,
      liveOverlayMerged: true,
      publicSensitiveOmitted: true,
    });
  });

  it.runIf(process.env.OPENCLAW_QA_REAL_GATEWAY === "1")(
    "crosses the real Gateway plugin-tool boundary",
    async () => {
      const proof = await runCachedHealthSnapshotBoundariesProof(
        path.resolve(import.meta.dirname, "../../../.."),
      );

      expect(proof.pluginLoaded).toBe(true);
      expect(proof.pluginToolCataloged).toBe(true);
      expect(proof.pluginToolInvoked).toBe(true);
      expect(proof.healthAfterTool).toBe(true);
    },
    180_000,
  );
});
