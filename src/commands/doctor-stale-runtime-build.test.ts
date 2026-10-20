import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectStaleRuntimeBuildFindings } from "./doctor-stale-runtime-build.js";

const BUILT = "1623683f478b1e4a2e3d5632585f006ea142e08c";
const HEAD = "5034f2ab174b5c76b0f2a7703ddb332572916e02";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makeCheckout(options: {
  built?: string;
  head?: string;
  immutableBuild?: unknown;
}): Promise<string> {
  const root = tempDirs.make("openclaw-stale-build-");
  if (options.built) {
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({
        version: "2026.8.1",
        commit: options.built,
        immutableBuild: options.immutableBuild,
      }),
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

    // Doctor exits non-zero only for refused config fixes and update advisories,
    // so this must stay a warning or it starts failing runs it only describes.
    const findings = await collectStaleRuntimeBuildFindings({ root, env: {} });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/stale-runtime-build",
        severity: "warning",
        message: expect.stringContaining(BUILT.slice(0, 7)),
      }),
    ]);
    expect(findings[0]?.message).toContain(HEAD.slice(0, 7));
  });

  it.each([
    ["during an update", { built: BUILT, head: HEAD }, { OPENCLAW_UPDATE_IN_PROGRESS: "1" }],
    ["without build provenance", { head: HEAD }, {}],
    ["when build and checkout match", { built: BUILT, head: BUILT }, {}],
  ])("stays silent %s", async (_label, checkout, env) => {
    const root = await makeCheckout(checkout);
    await expect(collectStaleRuntimeBuildFindings({ root, env })).resolves.toEqual([]);
  });

  it.each([
    [{ builtBy: "operator", isolation: "none" }, true],
    [{ builtBy: "operator", isolation: "none", account: "fixture", uid: 1002, gid: 1002 }, true],
    [{ builtBy: "isolated-account", isolation: "none" }, false],
    [{ builtBy: "operator", isolation: "systemd" }, false],
  ])(
    "reports only recorded operator builds without account isolation (%j)",
    async (immutableBuild, warns) => {
      const root = await makeCheckout({ built: BUILT, head: BUILT, immutableBuild });
      const findings = await collectStaleRuntimeBuildFindings({ root, env: {} });
      if (!warns) {
        expect(findings).toEqual([]);
        return;
      }
      expect(findings).toEqual([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("without an isolated build account"),
          details: immutableBuild,
          fixHint: expect.stringContaining("https://docs.openclaw.ai/cli/update"),
        }),
      ]);
    },
  );
});
