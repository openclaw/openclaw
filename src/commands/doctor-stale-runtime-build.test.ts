import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectStaleRuntimeBuildFindings } from "./doctor-stale-runtime-build.js";

const BUILT = "1623683f478b1e4a2e3d5632585f006ea142e08c";
const HEAD = "5034f2ab174b5c76b0f2a7703ddb332572916e02";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makeCheckout(options: { built?: string; head?: string }): Promise<string> {
  const root = tempDirs.make("openclaw-stale-build-");
  if (options.built) {
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ version: "2026.8.1", commit: options.built }),
    );
  }
  if (options.head) {
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "HEAD"), `${options.head}\n`);
  }
  return root;
}

describe("collectStaleRuntimeBuildFindings", () => {
  it("does not recommend rebuilding a host-owned payload with checkout metadata", async () => {
    const root = await makeCheckout({ built: BUILT, head: HEAD });
    await fs.writeFile(
      path.join(root, "openclaw-install-owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        owner: "macos-app",
        displayName: "OpenClaw.app",
        updateHint: "Update OpenClaw.app to update this Gateway.",
      }),
    );

    await expect(collectStaleRuntimeBuildFindings({ root, env: {} })).resolves.toEqual([]);
  });
  it("warns when the built commit differs from the checkout commit", async () => {
    const root = await makeCheckout({ built: BUILT, head: HEAD });

    const findings = await collectStaleRuntimeBuildFindings({ root, env: {} });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe("core/doctor/stale-runtime-build");
    // Doctor exits non-zero only for refused config fixes and update advisories,
    // so this must stay a warning or it starts failing runs it only describes.
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain(BUILT.slice(0, 7));
    expect(findings[0]?.message).toContain(HEAD.slice(0, 7));
  });

  it("stays silent while an update is in progress", async () => {
    const root = await makeCheckout({ built: BUILT, head: HEAD });

    // An update pulls source before rebuilding dist, so the drift this check
    // reports is the update's own expected intermediate state.
    await expect(
      collectStaleRuntimeBuildFindings({ root, env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" } }),
    ).resolves.toEqual([]);
  });

  it("stays silent for a checkout with no build provenance", async () => {
    const root = await makeCheckout({ head: HEAD });

    await expect(collectStaleRuntimeBuildFindings({ root, env: {} })).resolves.toEqual([]);
  });

  it("stays silent when the built commit matches the checkout", async () => {
    const root = await makeCheckout({ built: BUILT, head: BUILT });

    await expect(collectStaleRuntimeBuildFindings({ root, env: {} })).resolves.toEqual([]);
  });
});
