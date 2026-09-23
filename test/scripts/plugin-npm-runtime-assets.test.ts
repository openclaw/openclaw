import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPluginNpmRuntime } from "../../scripts/lib/plugin-npm-runtime-build.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function createAssetFixture(
  options: { tracked?: boolean; missing?: boolean; generated?: boolean } = {},
) {
  const repoRoot = createTempDir("openclaw-selected-plugin-assets-");
  const packageDir = path.join(repoRoot, "extensions", "demo");
  fs.mkdirSync(path.join(packageDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
  execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@fixture/demo",
      version: "1.0.0",
      type: "module",
      openclaw: {
        extensions: ["./index.ts"],
        build: {
          runtimeFormat: "esm",
          staticAssets: [{ source: "./assets/message.txt", output: "assets/message.txt" }],
        },
        ...(options.generated ? { assetScripts: { build: "node build-assets.cjs" } } : {}),
      },
    }),
  );
  fs.writeFileSync(path.join(packageDir, "openclaw.plugin.json"), '{"id":"demo"}');
  fs.writeFileSync(
    path.join(packageDir, "index.ts"),
    'import { readFileSync } from "node:fs"; export const message = readFileSync(new URL("./assets/message.txt", import.meta.url), "utf8");',
  );
  if (options.generated) {
    fs.writeFileSync(
      path.join(packageDir, "build-assets.cjs"),
      'require("node:fs").writeFileSync("assets/message.txt", "selected asset");',
    );
  } else if (!options.missing) {
    fs.writeFileSync(path.join(packageDir, "assets", "message.txt"), "selected asset");
  }
  if (options.tracked) {
    execFileSync("git", ["add", "extensions/demo/package.json"], { cwd: repoRoot });
  }
  return { repoRoot, packageDir };
}

describe("selected plugin runtime assets", () => {
  it.each([
    { name: "untracked package", options: {} },
    { name: "tracked package with a malformed unrelated manifest", options: { tracked: true } },
    { name: "asset generated after compilation", options: { generated: true } },
  ])("builds loadable assets for $name", async ({ options }) => {
    const fixture = createAssetFixture(options);
    if (options.tracked) {
      const other = path.join(fixture.repoRoot, "extensions", "other");
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, "package.json"), "{");
      execFileSync("git", ["add", "extensions/other/package.json"], { cwd: fixture.repoRoot });
    }

    const result = await buildPluginNpmRuntime({ ...fixture, logLevel: "silent" });
    expect(result?.copiedStaticAssets).toEqual(["dist/assets/message.txt"]);
    const entry = pathToFileURL(path.join(fixture.packageDir, "dist", "index.js")).href;
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `process.stdout.write((await import(${JSON.stringify(entry)})).message);`,
        ],
        { encoding: "utf8" },
      ),
    ).toBe("selected asset");
  });

  it("reports a missing selected asset instead of publishing an incomplete package", async () => {
    const fixture = createAssetFixture({ tracked: true, missing: true });
    await expect(buildPluginNpmRuntime({ ...fixture, logLevel: "silent" })).rejects.toThrow(
      "demo missing static asset source(s): extensions/demo/assets/message.txt",
    );
  });
});
