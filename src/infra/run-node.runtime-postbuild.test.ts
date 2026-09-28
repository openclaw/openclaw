// Runtime postbuild freshness, repair, and serialization at the node launcher boundary.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, onTestFinished, vi } from "vitest";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import {
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
} from "../../scripts/run-node.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  it,
  ROOT_SRC,
  ROOT_TSCONFIG,
  ROOT_PACKAGE,
  ROOT_TSDOWN,
  RUNTIME_POSTBUILD_IMPLEMENTATION_PATHS,
  GENERATED_PLUGIN_ASSET_BUNDLE,
  GENERATED_PLUGIN_ASSET_BUNDLE_HASH,
  DIST_ENTRY,
  BUILD_STAMP,
  RUNTIME_POSTBUILD_STAMP,
  DIST_PLUGIN_SDK_CORE,
  DIST_CHANNEL_CATALOG,
  DIST_BUILD_INFO,
  DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT,
  DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT,
  DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108,
  DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_2026_9_1,
  DIST_STABLE_ROOT_RUNTIME_SOURCE,
  DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT,
  DIST_STABLE_ROOT_RUNTIME_ALIAS,
  DIST_LEGACY_ROOT_RUNTIME_TARGET,
  DIST_LEGACY_ROOT_RUNTIME_COMPAT,
  EXTENSION_INDEX,
  EXTENSION_SRC,
  EXTENSION_SKILL,
  EXTENSION_MANIFEST,
  EXTENSION_PACKAGE,
  DIST_EXTENSION_INDEX,
  DIST_EXTENSION_SRC,
  DIST_EXTENSION_SKILL,
  DIST_EXTENSION_RUNTIME_SRC,
  DIST_RUNTIME_EXTENSION_INDEX,
  DIST_RUNTIME_EXTENSION_MANIFEST,
  DIST_RUNTIME_EXTENSION_PACKAGE,
  DIST_RUNTIME_EXTENSION_SKILL,
  DIST_OPENCLAW_ALIAS_PACKAGE,
  DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE,
  DIST_OPENCLAW_ALIAS_PLUGIN_SDK_STRING_COERCE,
  BUNDLED_HOOK_METADATA,
  DIST_BUNDLED_HOOK_METADATA,
  DIST_EXTENSION_MANIFEST,
  DIST_EXTENSION_PACKAGE,
  NEW_TIME,
  syncBundledPluginMetadata,
  statusCommandSpawn,
  gatewayStatusCommandSpawn,
  resolvePath,
  expectPathMissing,
  touchProjectFiles,
  setupTrackedProject,
  setupStampedProject,
  writeImmutableDeploymentManifest,
  createCurrentGitSpawnRecorder,
  createBuildRequirementDeps,
  trackProjectWithGit,
  runNodeCommand,
  runStatusCommand,
  expectManifestId,
} from "../../test/scripts/run-node.test-support.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

beforeEach(() => {
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
});

describe("run-node script", () => {
  it("skips runtime postbuild restaging in watch mode when dist is already current", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it("reruns runtime postbuild in watch mode when required outputs are missing with no runtime stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    await fs.rm(resolvePath(tmp, DIST_OPENCLAW_ALIAS_PACKAGE));

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  it("reruns runtime postbuild for dirty extension package metadata in watch mode", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.ts"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
      trackConfig: true,
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_PACKAGE}\0`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  it("skips runtime postbuild restaging when the runtime stamp is current", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it("runs current immutable deployment artifacts without refreshing them", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    await writeImmutableDeploymentManifest(tmp);

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      args: ["gateway", "status", "--deep", "--require-rpc", "--json"],
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([gatewayStatusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  for (const { label, missingPath, expectedReason } of [
    {
      label: "build output",
      missingPath: BUILD_STAMP,
      expectedReason: "build stamp missing",
    },
    {
      label: "runtime postbuild output",
      missingPath: DIST_OPENCLAW_ALIAS_PACKAGE,
      expectedReason: "required runtime postbuild output missing",
    },
  ]) {
    it(`refuses to regenerate missing ${label} in an immutable deployment`, async ({ tmp }) => {
      await setupStampedProject(tmp, {
        files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });
      await writeImmutableDeploymentManifest(tmp);
      await fs.rm(resolvePath(tmp, missingPath));

      const stderrChunks: string[] = [];
      const stderr = {
        write: (chunk: string | Buffer) => {
          stderrChunks.push(String(chunk));
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
      const exitCode = await runStatusCommand({
        tmp,
        args: ["gateway", "status", "--deep", "--require-rpc", "--json"],
        spawn,
        spawnSync,
        stderr,
        runRuntimePostBuild,
      });

      expect(exitCode).toBe(1);
      expect(spawnCalls).toEqual([]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
      expect(stderrChunks.join("")).toContain(expectedReason);
      expect(stderrChunks.join("")).toContain("node openclaw.mjs");
    });
  }

  it("restages runtime artifacts when runtime metadata is dirty", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
      trackConfig: true,
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_MANIFEST}\0`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  it.for(["stamp", "overlay"])(
    "serializes concurrent runtime restaging with a missing %s",
    async (missing, { tmp }) => {
      await setupStampedProject(tmp, {
        files:
          missing === "overlay"
            ? {
                [DIST_EXTENSION_INDEX]: "export default {};\n",
                [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
              }
            : {},
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });

      let markPostbuildStarted!: () => void;
      let releasePostbuild!: () => void;
      const postbuildStarted = new Promise<void>((resolve) => {
        markPostbuildStarted = resolve;
      });
      const postbuildRelease = new Promise<void>((resolve) => {
        releasePostbuild = resolve;
      });
      const { promise: waitingForLock, resolve: markWaiting } = createDeferred();
      const runRuntimePostBuild = vi.fn(async () => {
        markPostbuildStarted();
        await postbuildRelease;
        if (missing === "overlay") {
          const runtimePath = resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX);
          await fs.mkdir(path.dirname(runtimePath), { recursive: true });
          await fs.copyFile(resolvePath(tmp, DIST_EXTENSION_INDEX), runtimePath);
        }
      });
      const { spawn, spawnSync } = createCurrentGitSpawnRecorder();

      const options = {
        spawn,
        spawnSync,
        env: {
          OPENCLAW_RUNNER_LOG: "1",
          OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "1",
        },
        stderr: {
          write: (chunk: string | Uint8Array) => {
            if (String(chunk).includes("Waiting for TypeScript/runtime artifact lock")) {
              markWaiting();
            }
            return true;
          },
        },
        runRuntimePostBuild,
      };
      const runs = Promise.all([runNodeCommand(tmp, options), runNodeCommand(tmp, options)]);

      await postbuildStarted;
      await waitingForLock;
      releasePostbuild();
      await expect(runs).resolves.toEqual([0, 0]);

      expect(runRuntimePostBuild).toHaveBeenCalledTimes(1);
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
    },
  );

  it("reports clean runtime postbuild artifacts when the runtime stamp matches HEAD", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing runtime postbuild outputs even when stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts"]}}\n',
        [DIST_EXTENSION_SRC]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.js"]}}\n',
        [DIST_EXTENSION_RUNTIME_SRC]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });
    await fs.rm(resolvePath(tmp, DIST_EXTENSION_PACKAGE));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("restages missing runtime overlays from restored dist without plugin sources", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });
    await fs.rm(resolvePath(tmp, "extensions"), { recursive: true, force: true });
    await fs.rm(resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX));

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const runRuntimePostBuild = vi.fn(async () => {
      await fs.copyFile(
        resolvePath(tmp, DIST_EXTENSION_INDEX),
        resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX),
      );
    });
    const exitCode = await runStatusCommand({ tmp, spawn, spawnSync, runRuntimePostBuild });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
    await expect(fs.readFile(resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX), "utf8")).resolves.toBe(
      "export default {};\n",
    );
  });

  it("does not require OpenClaw SDK alias outputs when dist extensions are absent", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
        [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });
    await fs.rm(path.join(tmp, "dist", "extensions"), { recursive: true, force: true });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing OpenClaw SDK alias outputs when runtime stamps match HEAD", async ({
    tmp,
  }) => {
    await setupTrackedProject(tmp, {
      files: {
        [ROOT_SRC]: "export const value = 1;\n",
        [ROOT_PACKAGE]:
          '{"name":"openclaw-test","exports":{"./plugin-sdk/core":"./dist/plugin-sdk/core.js"}}\n',
        [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
        [DIST_OPENCLAW_ALIAS_PACKAGE]:
          '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/core":"./plugin-sdk/core.js"}}\n',
        [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE]: "export * from '../../../../plugin-sdk/core.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
      buildPaths: [
        ROOT_SRC,
        DIST_ENTRY,
        DIST_PLUGIN_SDK_CORE,
        DIST_OPENCLAW_ALIAS_PACKAGE,
        DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE,
        BUILD_STAMP,
        RUNTIME_POSTBUILD_STAMP,
      ],
    });
    await fs.rm(resolvePath(tmp, DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("does not require private OpenClaw SDK dist files that package exports omit", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [ROOT_PACKAGE]: JSON.stringify(
          {
            name: "openclaw-test",
            exports: {
              "./plugin-sdk/string-coerce-runtime": "./dist/plugin-sdk/string-coerce-runtime.js",
            },
          },
          null,
          2,
        ),
        "dist/plugin-sdk/string-coerce-runtime.js": "export const publicRuntime = true;\n",
        "dist/plugin-sdk/ssrf-runtime-internal.js": "export const internal = true;\n",
        [DIST_OPENCLAW_ALIAS_PACKAGE]:
          '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/string-coerce-runtime":"./plugin-sdk/string-coerce-runtime.js"}}\n',
        [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_STRING_COERCE]:
          "export * from '../../../../plugin-sdk/string-coerce-runtime.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing core runtime postbuild outputs when runtime stamps match HEAD", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_STABLE_ROOT_RUNTIME_SOURCE]: "export const value = 1;\n",
        [DIST_STABLE_ROOT_RUNTIME_ALIAS]: "export * from './model-catalog.runtime-AbCd1234.js';\n",
        [DIST_LEGACY_ROOT_RUNTIME_TARGET]: "export const transform = true;\n",
        [DIST_LEGACY_ROOT_RUNTIME_COMPAT]: "export * from './text-transforms.runtime.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    for (const missingPath of [
      DIST_CHANNEL_CATALOG,
      DIST_BUILD_INFO,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_2026_9_1,
      DIST_STABLE_ROOT_RUNTIME_ALIAS,
      DIST_LEGACY_ROOT_RUNTIME_COMPAT,
    ]) {
      const resolvedMissingPath = resolvePath(tmp, missingPath);
      const originalContent = await fs.readFile(resolvedMissingPath, "utf8");
      await fs.rm(resolvedMissingPath);
      const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
      await fs.writeFile(resolvedMissingPath, originalContent);
    }
  });

  it("reports missing bundled hook metadata when runtime stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [BUNDLED_HOOK_METADATA]: "# Demo hook\n",
        [DIST_BUNDLED_HOOK_METADATA]: "# Demo hook\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    expect(resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp))).toEqual({
      shouldSync: false,
      reason: "clean",
    });
    await fs.rm(resolvePath(tmp, DIST_BUNDLED_HOOK_METADATA));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("does not require ambiguous stable runtime aliases that postbuild cannot create", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_STABLE_ROOT_RUNTIME_SOURCE]: "export const value = 1;\n",
        [DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT]: "export const value = 2;\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing runtime skill outputs even when stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [EXTENSION_SKILL]: "# Demo\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [DIST_EXTENSION_SKILL]: "# Demo\n",
        [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [DIST_RUNTIME_EXTENSION_SKILL]: "# Demo\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });
    await fs.rm(resolvePath(tmp, DIST_RUNTIME_EXTENSION_SKILL));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("reports dirty runtime postbuild inputs separately from rebuild inputs", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
        [DIST_EXTENSION_INDEX]: "export default {};\n",
      },
      trackConfig: true,
    });

    const deps = createBuildRequirementDeps(tmp, { gitStatus: ` M ${EXTENSION_MANIFEST}\0` });

    expect(resolveBuildRequirement(deps)).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
    expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
      shouldSync: true,
      reason: "dirty_runtime_postbuild_inputs",
    });
  });

  it.each(RUNTIME_POSTBUILD_IMPLEMENTATION_PATHS)(
    "reports dirty runtime postbuild implementation %s",
    async (implementationPath) => {
      await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        await setupStampedProject(tmp, {
          files: {
            [implementationPath]: "export {};\n",
            [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
          },
          trackConfig: true,
        });

        const requirement = resolveRuntimePostBuildRequirement(
          createBuildRequirementDeps(tmp, { gitStatus: ` M ${implementationPath}\0` }),
        );

        expect(requirement).toEqual({
          shouldSync: true,
          reason: "dirty_runtime_postbuild_inputs",
        });
      });
    },
  );

  it("reports a newer hook metadata copier without git status", async ({ tmp }) => {
    const implementationPath = "scripts/copy-hook-metadata.ts";
    await setupStampedProject(tmp, {
      files: {
        [implementationPath]: "export {};\n",
        [RUNTIME_POSTBUILD_STAMP]: "{}\n",
      },
      newPaths: [implementationPath],
      trackConfig: true,
    });
    const deps = createBuildRequirementDeps(tmp);
    deps.spawnSync = () => ({ status: 1, stdout: "" });

    expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
      shouldSync: true,
      reason: "runtime_postbuild_input_mtime_newer",
    });
  });

  it("ignores dirty generated plugin bundle artifacts when dist is current", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const requirement = resolveBuildRequirement(
      createBuildRequirementDeps(tmp, {
        gitStatus: ` M ${GENERATED_PLUGIN_ASSET_BUNDLE_HASH}\0 M ${GENERATED_PLUGIN_ASSET_BUNDLE}\0`,
      }),
    );

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it.for([
    { label: "SKILL.md", fileName: "SKILL.md", changedFile: null, shouldSync: true },
    { label: "café.md", fileName: "café.md", changedFile: null, shouldSync: true },
    ...(process.platform === "win32"
      ? []
      : [
          {
            label: "POSIX backslash inside declared skills",
            fileName: "notes\\part.md",
            changedFile: null,
            shouldSync: true,
          },
          {
            label: "POSIX backslash outside declared skills",
            fileName: "SKILL.md",
            changedFile: "skills\\notes.md",
            shouldSync: false,
          },
        ]),
  ])(
    "reports bundled skill edits as runtime postbuild inputs: $label",
    async ({ fileName, changedFile, shouldSync }, { tmp }) => {
      const skillPath = bundledPluginFile("demo", `skills/${fileName}`);
      const changedPath = changedFile ? bundledPluginFile("demo", changedFile) : skillPath;
      const manifest = JSON.stringify({ id: "demo", skills: ["./skills"] });
      await setupStampedProject(tmp, {
        files: {
          [EXTENSION_INDEX]: "export default {};\n",
          [EXTENSION_MANIFEST]: manifest,
          [skillPath]: "# Demo\n",
          [DIST_EXTENSION_INDEX]: "export default {};\n",
          [DIST_EXTENSION_MANIFEST]: manifest,
          [bundledDistPluginFile("demo", `skills/${fileName}`)]: "# Demo\n",
          [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
          [DIST_RUNTIME_EXTENSION_MANIFEST]: manifest,
          [`dist-runtime/extensions/demo/skills/${fileName}`]: "# Demo\n",
          ...(changedFile ? { [changedPath]: "# Notes\n" } : {}),
        },
        trackConfig: true,
      });
      const { deps } = await trackProjectWithGit(tmp);
      expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
        shouldSync: false,
        reason: "clean",
      });

      await fs.writeFile(resolvePath(tmp, changedPath), "# Updated\n");
      await touchProjectFiles(tmp, [changedPath], NEW_TIME);
      expect(resolveBuildRequirement(deps)).toEqual({ shouldBuild: false, reason: "clean" });
      expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
        shouldSync,
        reason: shouldSync ? "dirty_runtime_postbuild_inputs" : "clean",
      });
    },
  );

  it("repairs missing bundled plugin metadata without rerunning tsdown", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
      },
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expectManifestId(tmp, DIST_EXTENSION_MANIFEST, "demo");
  });

  it("removes stale bundled plugin metadata when the source manifest is gone", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"stale","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"name":"stale"}\n',
      },
      trackConfig: true,
    });

    await fs.mkdir(resolvePath(tmp, bundledPluginRoot("demo")), { recursive: true });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expectPathMissing(resolvePath(tmp, DIST_EXTENSION_MANIFEST));
    await expectPathMissing(resolvePath(tmp, DIST_EXTENSION_PACKAGE));
  });
});
