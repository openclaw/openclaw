import { execFileSync, spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import { resolveRunNodeInputSignature } from "../../scripts/lib/run-node-input-state.mts";
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
    const at = (file: string) => path.join(cwd, file);
    const write = async (file: string, value: string) => {
      await fs.mkdir(path.dirname(at(file)), { recursive: true });
      await fs.writeFile(at(file), value);
    };
    const writeJson = (file: string, value: unknown) => write(file, JSON.stringify(value));
    await write(".gitignore", "dist/\n");
    await write("package.json", '{"name":"openclaw"}');
    await write("src/index.ts", "export const value = 1;\n");
    const testUtilities = [
      "src/index.test.ts",
      "src/index.test-utils.ts",
      "src/index.test-utils.tsx",
    ];
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
      ["commit", "-qm", "fixture"],
    ]) {
      execFileSync(
        "git",
        [
          "commit.gpgsign=false",
          "core.hooksPath=/dev/null",
          "user.name=Fixture",
          "user.email=fixture@example.test",
        ]
          .flatMap((setting) => ["-c", setting])
          .concat(args),
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
    const requirement = () => resolveBuildRequirement(deps, { allowEquivalentInputs: true });
    const change = async (file: string, content: string, expected: boolean | string) => {
      await write(file, content);
      const result = requirement();
      expect(typeof expected === "boolean" ? result.shouldBuild : result.reason).toBe(expected);
    };
    await write("src/index.ts", "export const value = 2;\n");
    const inputSignature = resolveRunNodeInputSignature(deps, "build");
    expect(inputSignature).toMatch(/^[a-f0-9]{64}$/u);
    await write("dist/entry.js", "export const value = 2;\n");
    writeBuildStamp({ cwd });
    expect(requirement().reason).toBe("dirty_watched_tree");
    writeBuildStamp({ cwd, inputSignature });
    expect(requirement().shouldBuild).toBe(false);
    expect(
      resolveBuildRequirement({
        ...deps,
        spawnSync: () => ({ status: 1, stdout: "" }),
      }).shouldBuild,
    ).toBe(true);
    const validStamp = await fs.readFile(deps.buildStampPath, "utf8");
    for (const malformed of ["", null, false]) {
      await writeJson("dist/.buildstamp", { ...JSON.parse(validStamp), inputSignature: malformed });
      expect(requirement().shouldBuild).toBe(true);
    }
    await fs.writeFile(deps.buildStampPath, validStamp);
    await writeJson("deployment.json", { kind: "git", sourceHead: JSON.parse(validStamp).head });
    expect(requirement().shouldBuild).toBe(true);
    await fs.unlink(path.join(cwd, "deployment.json"));
    for (const file of testUtilities) {
      await change(file, "corrected fixture\n", false);
    }
    for (const file of runtimeSupport) {
      await change(file, "export const value = 2;\n", "build_inputs_changed");
      await change(file, "export const value = 1;\n", false);
    }
    await fs.rename(at("src/index.ts"), at("src/renamed.ts"));
    expect(requirement().shouldBuild).toBe(true);
    await fs.rename(at("src/renamed.ts"), at("src/index.ts"));
    await fs.unlink(at("src/index.ts"));
    expect(requirement().shouldBuild).toBe(true);
    await write("src/index.ts", "export const value = 3;\n");
    await fs.utimes(at("src/index.ts"), new Date(0), new Date(0));
    expect(requirement().reason).toBe("build_inputs_changed");
    await change("src/index.ts", "export const value = 1;\n", true);
    await write("src/index.ts", "export const value = 2;\n");
    await change("pnpm-lock.yaml", "changed dependency\n", true);
    await change("pnpm-lock.yaml", "original lockfile\n", false);
    await write("src/index.ts", "export const value = 1;\n");
    await write("config/tsconfig/base.json", "{}\n");
    await write("dist/entry.js", "export const value = 1;\n");
    writeBuildStamp({ cwd, inputSignature: resolveRunNodeInputSignature(deps, "build") });
    expect(requirement().shouldBuild).toBe(false);
    await fs.rm(path.join(cwd, "config"), { recursive: true });
    expect(requirement().shouldBuild).toBe(true);
    await writeJson("extensions/example/package.json", {
      openclaw: {
        controlUi: "./browser/index.ts",
        assetScripts: { build: "build-ui", buildOutputs: ["openclaw.plugin.json"] },
      },
    });
    const manifest = (entry: string, enabled = true) =>
      JSON.stringify({ id: "example", configSchema: { enabled }, controlUi: { entry } });
    await write("extensions/example/openclaw.plugin.json", manifest("old.js"));
    await write("extensions/example/browser/index.css", "body { color: red; }");
    const assetsBefore = resolveRunNodeInputSignature(deps, "build");
    await write("extensions/example/openclaw.plugin.json", manifest("new.js"));
    expect(resolveRunNodeInputSignature(deps, "build")).toEqual(assetsBefore);
    await write("extensions/example/browser/index.test.ts", "fixture correction");
    expect(resolveRunNodeInputSignature(deps, "build")).toEqual(assetsBefore);
    await write("extensions/example/openclaw.plugin.json", manifest("new.js", false));
    expect(resolveRunNodeInputSignature(deps, "build")).not.toBe(assetsBefore);
    await write("extensions/example/openclaw.plugin.json", manifest("new.js"));
    await write("extensions/example/browser/index.css", "body { color: blue; }");
    expect(resolveRunNodeInputSignature(deps, "build")).not.toBe(assetsBefore);
    await fs.unlink(deps.distEntry);
    expect(requirement().reason).toBe("missing_dist_entry");
  });
});

it("reuses clean test capsules across carrier commits but preserves strict CLI and deployment heads", async () => {
  await withTestDir({ prefix: "openclaw-carrier-build-" }, async (cwd) => {
    const at = (file: string) => path.join(cwd, file);
    const write = (file: string, value: string) => fs.writeFile(at(file), value);
    await setupStampedProject(cwd, {
      files: {
        "src/entry.test.ts": "original fixture\n",
        "packages/session-url-contract/src/index.ts": "export const value = 1;\n",
      },
    });
    const { git, deps } = await trackProjectWithGit(cwd);
    const requirement = () => resolveBuildRequirement(deps, { allowEquivalentInputs: true });
    const preparation = () => resolveRunNodePreparation(cwd, {}, { allowEquivalentInputs: true });
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    const commit = () =>
      git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "carrier");
    writeBuildStamp({ cwd, inputSignature: resolveRunNodeInputSignature(deps, "build") });
    writeRuntimePostBuildStamp({
      cwd,
      inputSignature: resolveRunNodeInputSignature(deps, "runtime"),
    });
    commit();
    expect(resolveBuildRequirement(deps).reason).toBe("git_head_changed");
    expect(preparation()).toEqual({ build: false, runtime: false, immutable: false });
    const stampFile = deps.buildStampPath;
    const validStamp = await fs.readFile(stampFile, "utf8");
    const validStampTime = await fs.stat(stampFile);
    const legacy = JSON.parse(validStamp);
    delete legacy.inputSignature;
    await fs.writeFile(stampFile, JSON.stringify(legacy));
    expect(requirement().reason).toBe("git_head_changed");
    await fs.writeFile(stampFile, validStamp);
    await fs.utimes(stampFile, validStampTime.atime, validStampTime.mtime);
    await write("src/entry.test.ts", "corrected fixture\n");
    git("add", "src/entry.test.ts");
    commit();
    expect(preparation().build).toBe(false);
    await write(
      "deployment.json",
      JSON.stringify({ kind: "git", sourceHead: git("rev-parse", "HEAD") }),
    );
    expect(preparation().immutable).toBe(true);
    await fs.unlink(at("deployment.json"));
    await write("packages/session-url-contract/src/index.ts", "export const value = 2;\n");
    git("add", "packages/session-url-contract/src/index.ts");
    commit();
    expect(requirement().reason).toBe("build_inputs_changed");
  });
});
