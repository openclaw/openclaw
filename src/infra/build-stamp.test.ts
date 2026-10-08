import { execFileSync, spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import { captureRunNodeInputState } from "../../scripts/lib/run-node-input-state.mts";
import { resolveBuildRequirement, resolveRunNodePreparation } from "../../scripts/run-node.mts";
import {
  setupStampedProject,
  trackProjectWithGit,
} from "../../test/scripts/run-node.test-support.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

describe("build-stamp script", () => {
  it.each([
    { name: "clean", gitStatus: "", inputsClean: true },
    { name: "dirty source", gitStatus: " M src/index.ts\0", inputsClean: false },
    { name: "ignored test", gitStatus: " M src/index.test.ts\0", inputsClean: true },
    { name: "unknown", gitStatus: null, inputsClean: null },
  ])("records $name build inputs with the current git head", async ({ gitStatus, inputsClean }) => {
    await withTestDir({ prefix: "openclaw-build-stamp-" }, async (tmp) => {
      const stampPath = writeBuildStamp({
        cwd: tmp,
        now: () => 1_700_000_000_000,
        spawnSync: (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: "abc123\n" };
          }
          return cmd === "git" && args[0] === "status" && gitStatus !== null
            ? { status: 0, stdout: gitStatus }
            : { status: 1, stdout: "" };
        },
      });
      expect(stampPath.endsWith(`/dist/${BUILD_STAMP_FILE}`)).toBe(true);

      expect(JSON.parse(await fs.readFile(stampPath, "utf8"))).toEqual({
        builtAt: 1_700_000_000_000,
        head: "abc123",
        inputsClean,
      });
    });
  });
});

it("reuses built dirty inputs but rejects changed production, dependencies and missing output", async () => {
  await withTestDir({ prefix: "openclaw-dirty-build-" }, async (cwd) => {
    const write = async (file: string, value: string) => {
      await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await fs.writeFile(path.join(cwd, file), value);
    };
    await write(".gitignore", "dist/\n");
    await write("package.json", '{"name":"openclaw"}');
    await write("src/index.ts", "export const value = 1;\n");
    await write("src/index.test.ts", "original fixture\n");
    const testUtilities = ["src/index.test-utils.ts", "src/index.test-utils.tsx"];
    for (const file of testUtilities) {
      await write(file, "original fixture\n");
    }
    const runtimeSupport = [
      "src/test-utils.ts",
      "src/runtime.test-support.ts",
      "src/runtime.test-harness.ts",
      "src/test-api.ts",
    ];
    for (const file of runtimeSupport) {
      await write(file, "export const value = 1;\n");
    }
    await write(
      "src/runtime-entry.ts",
      runtimeSupport.map((file) => `import "./${path.basename(file, ".ts")}.js";`).join("\n"),
    );
    await write("src/stable.ts", "export const stable = 1;\n");
    await write("pnpm-lock.yaml", "original lockfile\n");
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "fixture",
      ],
    ]) {
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
        { cwd },
      );
    }
    const deps = {
      cwd,
      env: {},
      fs: fsSync,
      spawnSync,
      distRoot: path.join(cwd, "dist"),
      distEntry: path.join(cwd, "dist/entry.js"),
      buildStampPath: path.join(cwd, "dist/.buildstamp"),
      sourceRoots: [],
      configFiles: [],
    };
    const originalRead = fsSync.readFileSync;
    const read = vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => {
      const contents = originalRead(...args);
      if (args[0] === path.join(cwd, "src/stable.ts")) {
        fsSync.writeFileSync(path.join(cwd, "src/index.ts"), "export const value = 2;\n");
        fsSync.writeFileSync(path.join(cwd, "src/index.ts"), "export const value = 1;\n");
      }
      return contents;
    });
    let changedDuringCapture;
    try {
      changedDuringCapture = captureRunNodeInputState(deps, "build");
    } finally {
      read.mockRestore();
    }
    expect(changedDuringCapture).not.toBeNull();
    expect(() => writeBuildStamp({ cwd, inputState: changedDuringCapture })).toThrow(
      "Build inputs changed",
    );
    await write("src/index.ts", "export const value = 2;\n");
    const inputState = captureRunNodeInputState(deps, "build");
    expect(inputState?.signature).toMatch(/^[a-f0-9]{64}$/u);
    await write("dist/entry.js", "export const value = 2;\n");
    writeBuildStamp({ cwd });
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).reason).toBe(
      "dirty_watched_tree",
    );
    writeBuildStamp({ cwd, inputState });
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(false);
    await write("src/stable.ts", "export const stable = 2;\n");
    await write("src/stable.ts", "export const stable = 1;\n");
    expect(() => writeBuildStamp({ cwd, inputState })).toThrow("Build inputs changed");
    expect(
      resolveBuildRequirement({
        ...deps,
        spawnSync: () => ({ status: 1, stdout: "" }),
      }).shouldBuild,
    ).toBe(true);
    const validStamp = await fs.readFile(deps.buildStampPath, "utf8");
    for (const malformed of ["", null, false]) {
      await fs.writeFile(
        deps.buildStampPath,
        JSON.stringify({
          ...JSON.parse(validStamp),
          inputSignature: malformed,
        }),
      );
      expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(true);
    }
    await fs.writeFile(deps.buildStampPath, validStamp);
    await write(
      "deployment.json",
      JSON.stringify({ kind: "git", sourceHead: JSON.parse(validStamp).head }),
    );
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(true);
    await fs.unlink(path.join(cwd, "deployment.json"));
    await write("src/index.test.ts", "corrected fixture\n");
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(false);
    for (const file of testUtilities) {
      await write(file, "corrected fixture\n");
      expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(
        false,
      );
    }
    for (const file of runtimeSupport) {
      await write(file, "export const value = 2;\n");
      expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).reason).toBe(
        "build_inputs_changed",
      );
      await write(file, "export const value = 1;\n");
      expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(
        false,
      );
    }
    await fs.rename(path.join(cwd, "src/index.ts"), path.join(cwd, "src/renamed.ts"));
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(true);
    await fs.rename(path.join(cwd, "src/renamed.ts"), path.join(cwd, "src/index.ts"));
    await fs.unlink(path.join(cwd, "src/index.ts"));
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(true);
    await write("src/index.ts", "export const value = 3;\n");
    await fs.utimes(path.join(cwd, "src/index.ts"), new Date(0), new Date(0));
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).reason).toBe(
      "build_inputs_changed",
    );
    expect(() => writeBuildStamp({ cwd, inputState })).toThrow("Build inputs changed");
    await write("src/index.ts", "export const value = 2;\n");
    expect(() => writeBuildStamp({ cwd, inputState })).toThrow("Build inputs changed");
    await write("src/index.ts", "export const value = 1;\n");
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(true);
    await write("src/index.ts", "export const value = 2;\n");
    await write("pnpm-lock.yaml", "changed dependency\n");
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(true);
    await write("pnpm-lock.yaml", "original lockfile\n");
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(false);
    await write("src/index.ts", "export const value = 1;\n");
    await write("config/tsconfig/base.json", "{}\n");
    await write("dist/entry.js", "export const value = 1;\n");
    writeBuildStamp({ cwd, inputState: captureRunNodeInputState(deps, "build") });
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(false);
    await fs.rm(path.join(cwd, "config"), { recursive: true });
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).shouldBuild).toBe(true);
    await write(
      "extensions/example/package.json",
      JSON.stringify({
        openclaw: {
          controlUi: "./browser/index.ts",
          assetScripts: { build: "build-ui", buildOutputs: ["openclaw.plugin.json"] },
        },
      }),
    );
    const manifest = (entry: string, enabled = true) =>
      JSON.stringify({ id: "example", configSchema: { enabled }, controlUi: { entry } });
    await write("extensions/example/openclaw.plugin.json", manifest("old.js"));
    await write("extensions/example/browser/index.css", "body { color: red; }");
    const assetsBefore = captureRunNodeInputState(deps, "build", { assetPhase: true });
    const compilerBefore = captureRunNodeInputState(deps, "build");
    await write("extensions/example/openclaw.plugin.json", manifest("new.js"));
    expect(captureRunNodeInputState(deps, "build", { assetPhase: true })).toEqual(assetsBefore);
    expect(captureRunNodeInputState(deps, "build")?.generation).not.toBe(
      compilerBefore?.generation,
    );
    await write("extensions/example/browser/index.test.ts", "fixture correction");
    expect(captureRunNodeInputState(deps, "build", { assetPhase: true })).toEqual(assetsBefore);
    await write("extensions/example/openclaw.plugin.json", manifest("new.js", false));
    expect(captureRunNodeInputState(deps, "build", { assetPhase: true })?.signature).not.toBe(
      assetsBefore?.signature,
    );
    await write("extensions/example/openclaw.plugin.json", manifest("new.js"));
    await write("extensions/example/browser/index.css", "body { color: blue; }");
    expect(captureRunNodeInputState(deps, "build", { assetPhase: true })?.signature).not.toBe(
      assetsBefore?.signature,
    );
    await fs.unlink(deps.distEntry);
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).reason).toBe(
      "missing_dist_entry",
    );
  });
});

it("reuses clean test capsules across carrier commits but preserves strict CLI and deployment heads", async () => {
  await withTestDir({ prefix: "openclaw-carrier-build-" }, async (cwd) => {
    await setupStampedProject(cwd, {
      files: {
        "src/entry.test.ts": "original fixture\n",
        "packages/session-url-contract/src/index.ts": "export const value = 1;\n",
      },
    });
    const { git, deps } = await trackProjectWithGit(cwd);
    const commit = () =>
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "carrier",
      );
    writeBuildStamp({ cwd, inputState: captureRunNodeInputState(deps, "build") });
    writeRuntimePostBuildStamp({ cwd, inputState: captureRunNodeInputState(deps, "runtime") });
    commit();
    expect(resolveBuildRequirement(deps).reason).toBe("git_head_changed");
    expect(resolveRunNodePreparation(cwd, {}, { allowEquivalentInputs: true })).toEqual({
      build: false,
      runtime: false,
      immutable: false,
    });
    const stampFile = deps.buildStampPath;
    const validStamp = await fs.readFile(stampFile, "utf8");
    const validStampTime = await fs.stat(stampFile);
    const legacy = JSON.parse(validStamp);
    delete legacy.inputSignature;
    await fs.writeFile(stampFile, JSON.stringify(legacy));
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).reason).toBe(
      "git_head_changed",
    );
    await fs.writeFile(stampFile, validStamp);
    await fs.utimes(stampFile, validStampTime.atime, validStampTime.mtime);
    await fs.writeFile(path.join(cwd, "src/entry.test.ts"), "corrected fixture\n");
    git("add", "src/entry.test.ts");
    commit();
    expect(resolveRunNodePreparation(cwd, {}, { allowEquivalentInputs: true }).build).toBe(false);
    await fs.writeFile(
      path.join(cwd, "deployment.json"),
      JSON.stringify({ kind: "git", sourceHead: git("rev-parse", "HEAD") }),
    );
    expect(resolveRunNodePreparation(cwd, {}, { allowEquivalentInputs: true }).immutable).toBe(
      true,
    );
    await fs.unlink(path.join(cwd, "deployment.json"));
    await fs.writeFile(
      path.join(cwd, "packages/session-url-contract/src/index.ts"),
      "export const value = 2;\n",
    );
    git("add", "packages/session-url-contract/src/index.ts");
    commit();
    expect(resolveBuildRequirement(deps, { allowEquivalentInputs: true }).reason).toBe(
      "build_inputs_changed",
    );
  });
});
