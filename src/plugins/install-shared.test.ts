import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installPluginDirectoryIntoExtensions } from "./install-shared.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";

describe("installPluginDirectoryIntoExtensions", () => {
  const tempRoots = createSyncSuiteTempRootTracker("openclaw-install-shared");
  afterAll(() => tempRoots.cleanup());

  function fixture(contents = "export default {};\n") {
    const fixtureRoot = tempRoots.makeTempDir();
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "extensions", "demo");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "index.js"), contents);
    return {
      sourceDir,
      targetDir,
      pluginId: "demo",
      extensions: ["index.js"],
      logger: {},
      timeoutMs: 1_000,
      mode: "install",
      dryRun: false,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "Installing dependencies…",
    } satisfies Parameters<typeof installPluginDirectoryIntoExtensions>[0];
  }

  it("preserves structured warnings returned by a staged dependency scan", async () => {
    const options = fixture();
    const installPolicyWarning = {
      targetName: "demo",
      targetType: "plugin" as const,
      requestMode: "install" as const,
      reason: "Review the installed dependency tree",
    };

    const result = await installPluginDirectoryIntoExtensions({
      ...options,
      afterInstall: async () => ({
        ok: false,
        error: installPolicyWarning.reason,
        code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
        installPolicyWarning,
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: installPolicyWarning.reason,
      code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
      installPolicyWarning,
    });
    expect(fs.existsSync(options.targetDir)).toBe(false);
  });

  it("reviews the final staged artifact after source-copy mutations", async () => {
    const options = fixture("original capabilities");
    let reviewedArtifactDir: string | undefined;
    let reviewedArtifactContents: string | undefined;

    const result = await installPluginDirectoryIntoExtensions({
      ...options,
      afterCopy: async (installedDir) => {
        await fs.promises.writeFile(path.join(installedDir, "index.js"), "final capabilities");
      },
      onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
        reviewedArtifactDir = stagedArtifactDir;
        reviewedArtifactContents = await fs.promises.readFile(
          path.join(stagedArtifactDir, "index.js"),
          "utf8",
        );
      },
    });

    expect(result.ok).toBe(true);
    expect(reviewedArtifactDir).not.toBe(options.sourceDir);
    expect(reviewedArtifactContents).toBe("final capabilities");
    expect(fs.readFileSync(path.join(options.targetDir, "index.js"), "utf8")).toBe(
      "final capabilities",
    );
    expect(fs.readFileSync(path.join(options.sourceDir, "index.js"), "utf8")).toBe(
      "original capabilities",
    );
  });

  it("preserves the original consent rejection while rolling back the staged artifact", async () => {
    const options = fixture();
    const consentRejection = new Error("plugin capabilities require review");

    await expect(
      installPluginDirectoryIntoExtensions({
        ...options,
        onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
          expect(stagedArtifactDir).not.toBe(options.sourceDir);
          throw consentRejection;
        },
      }),
    ).rejects.toBe(consentRejection);
    expect(fs.existsSync(options.targetDir)).toBe(false);
  });
});
