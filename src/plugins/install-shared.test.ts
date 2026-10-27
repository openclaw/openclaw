import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { installPluginDirectoryIntoExtensions as installDirectory } from "./install-shared.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";

const tempRoots = createSyncSuiteTempRootTracker("openclaw-install-shared");
afterAll(() => tempRoots.cleanup());
const read = (dir: string) => fs.readFileSync(path.join(dir, "index.js"), "utf8");

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
  } satisfies Parameters<typeof installDirectory>[0];
}

it("preserves structured warnings returned by a staged dependency scan", async () => {
  const options = fixture();
  const installPolicyWarning = {
    targetName: "demo",
    targetType: "plugin" as const,
    requestMode: "install" as const,
    reason: "Review the installed dependency tree",
  };

  const failure = {
    ok: false as const,
    error: installPolicyWarning.reason,
    code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
    installPolicyWarning,
  };
  const result = await installDirectory({
    ...options,
    afterInstall: async () => failure,
  });
  expect(result).toEqual(failure);
  expect(fs.existsSync(options.targetDir)).toBe(false);
});

it("reviews the final staged artifact after source-copy mutations", async () => {
  const options = fixture("original capabilities");
  let reviewed: { dir: string; contents: string } | undefined;
  const result = await installDirectory({
    ...options,
    afterInstall: async (installedDir) => {
      await fs.promises.writeFile(path.join(installedDir, "index.js"), "final capabilities");
      return null;
    },
    onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
      reviewed = { dir: stagedArtifactDir, contents: read(stagedArtifactDir) };
    },
  });

  expect(result.ok).toBe(true);
  expect(reviewed?.contents).toBe("final capabilities");
  expect(reviewed?.dir).not.toBe(options.sourceDir);
  expect(read(options.targetDir)).toBe("final capabilities");
  expect(read(options.sourceDir)).toBe("original capabilities");
});

it("preserves the original consent rejection while rolling back the staged artifact", async () => {
  const options = fixture();
  const consentRejection = new Error("plugin capabilities require review");

  await expect(
    installDirectory({
      ...options,
      onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
        expect(stagedArtifactDir).not.toBe(options.sourceDir);
        throw consentRejection;
      },
    }),
  ).rejects.toBe(consentRejection);
  expect(fs.existsSync(options.targetDir)).toBe(false);
});
