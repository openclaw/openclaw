import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { RUNTIME_POSTBUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import { resolveRunNodeInputSignature } from "../../scripts/lib/run-node-input-state.mts";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsToRuntimeOverlay,
} from "../../scripts/lib/static-extension-assets.mts";
import {
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
} from "../../scripts/run-node.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { setupStampedProject, trackProjectWithGit } from "./run-node.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reuses build and runtime stamps across install timestamps while retaining dependency identity", async () => {
  const cwd = tempDirs.make("runtime-stamp-install-");
  const metadata = {
    packageManager: "pnpm@12.15.0",
    layoutVersion: 5,
    virtualStoreDir: ".pnpm",
    hoistedDependencies: { "demo@1.0.0": { demo: "private" } },
    included: { dependencies: true },
    prunedAt: "Thu, 26 Nov 2026 01:00:00 GMT",
  };
  await setupStampedProject(cwd, {
    files: {
      ".gitignore": "node_modules/\ndist/\n",
      "node_modules/.modules.yaml": JSON.stringify(metadata),
    },
  });
  const { deps } = await trackProjectWithGit(cwd);
  for (const scope of ["build", "runtime"] as const) {
    const inputSignature = resolveRunNodeInputSignature(deps, scope);
    expect(inputSignature).not.toBeNull();
    const writeStamp = scope === "build" ? writeBuildStamp : writeRuntimePostBuildStamp;
    writeStamp({ cwd, env: deps.env, inputSignature });
  }
  const buildStamp = fs.readFileSync(deps.buildStampPath, "utf8");
  const runtimeStamp = fs.readFileSync(deps.runtimePostBuildStampPath, "utf8");
  const requirement = () => [
    resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild,
    resolveRuntimePostBuildRequirement(deps, { allowEquivalentInputs: true }).shouldSync,
  ];
  expect(requirement()).toEqual([false, false]);
  const writeMetadata = (value: unknown) =>
    fs.writeFileSync(path.join(cwd, "node_modules/.modules.yaml"), JSON.stringify(value));
  writeMetadata({ ...metadata, prunedAt: "Fri, 27 Nov 2026 09:00:00 GMT" });
  expect(requirement()).toEqual([false, false]);
  for (const change of [
    { packageManager: "pnpm@12.16.0" },
    { layoutVersion: 6 },
    { virtualStoreDir: "another-store" },
    { hoistedDependencies: { "demo@2.0.0": { demo: "private" } } },
    { included: { dependencies: false } },
    { allowBuilds: { demo: false } },
    { futureInstallInput: "changed" },
    { prunedAt: { unknown: true } },
  ]) {
    writeMetadata({ ...metadata, ...change });
    expect(requirement()).toEqual([true, true]);
  }
  for (const unrecognized of ["layoutVersion: 5\n", "{malformed", "[]"]) {
    fs.writeFileSync(path.join(cwd, "node_modules/.modules.yaml"), unrecognized);
    expect(requirement()).toEqual([true, true]);
  }
  for (const unsupported of [{ packageManager: "pnpm@13.0.0" }, { layoutVersion: 6 }]) {
    writeMetadata({ ...metadata, ...unsupported });
    const signatures = (["build", "runtime"] as const).map((scope) =>
      resolveRunNodeInputSignature(deps, scope),
    );
    writeMetadata({ ...metadata, ...unsupported, prunedAt: "Fri, 27 Nov 2026 09:00:00 GMT" });
    for (const [index, scope] of (["build", "runtime"] as const).entries()) {
      expect(resolveRunNodeInputSignature(deps, scope)).not.toBe(signatures[index]);
    }
  }
  expect(fs.readFileSync(deps.buildStampPath, "utf8")).toBe(buildStamp);
  expect(fs.readFileSync(deps.runtimePostBuildStampPath, "utf8")).toBe(runtimeStamp);
});

it.each([
  ["clean", "", true],
  ["skipped assets", "", true],
  ["dirty metadata", " M extensions/demo/openclaw.plugin.json\0", false],
  ["CLI diagnostic preload", " M src/cli/cli-process-diagnostics.test-support.cjs\0", false],
  ["dirty CLI process observer", " M src/cli/cli-process-tree.test-support.cjs\0", false],
  ["source-only change", " M src/index.ts\0", true],
  ["unknown", null, null],
] as const)(
  "records %s runtime inputs with the current git head",
  (name, gitStatus, inputsClean) => {
    const rootDir = tempDirs.make("openclaw-runtime-postbuild-stamp-");
    const stampPath = writeRuntimePostBuildStamp({
      cwd: rootDir,
      now: () => 123,
      env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: name === "skipped assets" ? "0" : "1" },
      spawnSync: (_command, args) =>
        args[0] === "rev-parse"
          ? { status: 0, stdout: "abc123\n" }
          : gitStatus === null
            ? { status: 1, stdout: "" }
            : { status: 0, stdout: gitStatus },
    });

    expect(path.relative(rootDir, stampPath)).toBe(path.join("dist", RUNTIME_POSTBUILD_STAMP_FILE));
    expect(JSON.parse(fs.readFileSync(stampPath, "utf8"))).toEqual({
      syncedAt: 123,
      head: "abc123",
      inputsClean,
      staticAssets: name !== "skipped assets",
    });
  },
);
it("does not reuse skipped static assets for a full runtime reader", async () => {
  const cwd = tempDirs.make("runtime-stamp-assets-");
  const source = "extensions/demo/asset.txt";
  const asset = "asset.txt";
  const output = `dist/${source}`;
  const overlay = `dist-runtime/${source}`;
  await setupStampedProject(cwd, {
    files: {
      "extensions/demo/package.json": JSON.stringify({
        openclaw: { build: { staticAssets: [{ source: asset, output: asset }] } },
      }),
      [source]: "A",
      [output]: "A",
      [overlay]: "A",
    },
  });
  const { deps } = await trackProjectWithGit(cwd);
  const requirement = (env = deps.env) =>
    resolveRuntimePostBuildRequirement({ ...deps, env }, { allowEquivalentInputs: true });
  fs.writeFileSync(path.join(cwd, source), "B");
  const env = { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" };
  writeRuntimePostBuildStamp({
    cwd,
    env,
    inputSignature: resolveRunNodeInputSignature({ ...deps, env }, "runtime"),
  });
  expect(fs.readFileSync(path.join(cwd, output), "utf8")).toBe("A");
  expect(requirement().reason).toBe("static_assets_not_prepared");
  expect(requirement(env).shouldSync).toBe(false);
  const inputSignature = resolveRunNodeInputSignature(deps, "runtime");
  copyStaticExtensionAssets({ rootDir: cwd, env: {} });
  copyStaticExtensionAssetsToRuntimeOverlay({ rootDir: cwd, env: {} });
  writeRuntimePostBuildStamp({ cwd, env: {}, inputSignature });
  expect(fs.readFileSync(path.join(cwd, output), "utf8")).toBe("B");
  expect(requirement().shouldSync).toBe(false);
  expect(requirement(env).shouldSync).toBe(false);
  const stamp = path.join(cwd, "dist", RUNTIME_POSTBUILD_STAMP_FILE);
  const recorded = JSON.parse(fs.readFileSync(stamp, "utf8"));
  fs.writeFileSync(stamp, JSON.stringify({ ...recorded, staticAssets: "unknown" }));
  expect(requirement().reason).toBe("static_assets_not_prepared");
});
