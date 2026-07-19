// Live Docker Stage tests cover live docker stage script behavior.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addStagedPrivatePluginSdkExports } from "../../scripts/live-docker-stage-private-sdk-exports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stageScriptPath = path.join(repoRoot, "scripts/lib/live-docker-stage.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("live Docker state staging", () => {
  it("keeps repo-local generated artifacts out of the source copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=.artifacts");
    expect(script).toContain('node "$scripts_dir/live-docker-stage-private-sdk-exports.mjs"');
  });

  it("adds private SDK source exports only to the disposable source stage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-stage-sdk-"));
    tempDirs.push(root);
    mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(root, "src", "plugin-sdk"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" } }),
    );
    writeFileSync(
      path.join(root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      JSON.stringify(["keyed-async-queue"]),
    );
    writeFileSync(path.join(root, "src", "plugin-sdk", "keyed-async-queue.ts"), "export {};\n");

    addStagedPrivatePluginSdkExports(root);

    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.exports).toEqual({
      "./plugin-sdk/core": "./dist/plugin-sdk/core.js",
      "./plugin-sdk/keyed-async-queue": {
        types: "./src/plugin-sdk/keyed-async-queue.ts",
        default: "./src/plugin-sdk/keyed-async-queue.ts",
      },
    });
  });

  it("keeps host-only generated registry state out of the container copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=workspace");
    expect(script).toContain("--exclude=sandboxes");
    expect(script).toContain("--exclude=plugins/installs.json");
    expect(script).toContain("--exclude=plugins/installs.json.migrated");
    expect(script).toContain("DELETE FROM installed_plugin_index");
    expect(script).toContain("PRAGMA secure_delete = ON");
    expect(script).toContain("VACUUM");
    expect(script).toContain("host-absolute paths");
  });
});
