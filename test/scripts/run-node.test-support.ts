// Shared filesystem and process fixtures for the node launcher boundary.
// Tests node process runner lifecycle and captured output.
import { execFileSync, spawnSync as realSpawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "openclaw/plugin-sdk/test-fixtures";
import { expect, it as baseIt, vi } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import {
  UPDATE_COMPATIBILITY_INVENTORY_FILE,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { runNodeMain } from "../../scripts/run-node.mts";
import { withTestDir } from "../../src/test-helpers/temp-dir.js";
// These launcher fixtures have no service. Publication custody is covered at its owner.
vi.mock("../../src/cli/update-cli/update-command-service-publication.js", () => ({
  withGatewayRuntimeArtifactPublication: async (
    _params: unknown,
    publish: () => Promise<unknown>,
  ) => publish(),
}));
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";
export const it = baseIt.extend<{ tmp: string }>({
  tmp: async ({ task: _task }, use) => {
    await withTestDir({ prefix: "openclaw-run-node-" }, use);
  },
});

export const ROOT_SRC = "src/index.ts";
export const ROOT_TSCONFIG = "tsconfig.json";
export const ROOT_PACKAGE = "package.json";
export const ROOT_TSDOWN = "tsdown.config.ts";
export const RUNTIME_POSTBUILD_IMPLEMENTATION_PATHS = [
  "scripts/check-built-plugin-control-plane-modules.mts",
  "scripts/copy-bundled-plugin-metadata.mts",
  "scripts/copy-hook-metadata.ts",
  "scripts/runtime-postbuild.mts",
  "scripts/stage-bundled-plugin-runtime.mts",
  "scripts/write-build-info.ts",
  "scripts/write-official-channel-catalog.mts",
] as const;
const DEPLOYMENT_MANIFEST = "deployment.json";
export const GENERATED_PLUGIN_ASSET_BUNDLE = "extensions/demo/src/host/assets/view.bundle.js";
export const GENERATED_PLUGIN_ASSET_BUNDLE_HASH = "extensions/demo/src/host/assets/.bundle.hash";
export const DIST_ENTRY = "dist/entry.js";
export const BUILD_STAMP = `dist/${BUILD_STAMP_FILE}`;
export const RUNTIME_POSTBUILD_STAMP = `dist/${RUNTIME_POSTBUILD_STAMP_FILE}`;
export const DIST_PLUGIN_SDK_CORE = "dist/plugin-sdk/core.js";
export const DIST_CHANNEL_CATALOG = "dist/channel-catalog.json";
export const DIST_BUILD_INFO = "dist/build-info.json";
export const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT = "dist/shared-Y6bNiw2w.js";
export const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT = "dist/shared-DTaQo6Hi.js";
export const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108 = "dist/shared-1Uyqkfns.js";
export const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_2026_9_1 = "dist/shared-DFJEouXv.js";
export const DIST_STABLE_ROOT_RUNTIME_SOURCE = "dist/model-catalog.runtime-AbCd1234.js";
export const DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT = "dist/model-catalog.runtime-EfGh5678.js";
export const DIST_STABLE_ROOT_RUNTIME_ALIAS = "dist/model-catalog.runtime.js";
export const DIST_LEGACY_ROOT_RUNTIME_TARGET = "dist/text-transforms.runtime.js";
export const DIST_LEGACY_ROOT_RUNTIME_COMPAT = "dist/text-transforms.runtime-sEqsN4pN.js";
export const QA_LAB_PLUGIN_SDK_ENTRY = "dist/plugin-sdk/qa-lab.js";
export const QA_RUNTIME_PLUGIN_SDK_ENTRY = "dist/plugin-sdk/qa-runtime.js";
export const EXTENSION_INDEX = bundledPluginFile("demo", "index.ts");
export const EXTENSION_SRC = bundledPluginFile("demo", "src/index.ts");
export const EXTENSION_EXTRA_SRC = bundledPluginFile("demo", "src/extra.ts");
export const EXTENSION_SKILL = bundledPluginFile("demo", "skills/SKILL.md");
export const EXTENSION_MANIFEST = bundledPluginFile("demo", "openclaw.plugin.json");
export const EXTENSION_PACKAGE = bundledPluginFile("demo", "package.json");
export const EXTENSION_README = bundledPluginFile("demo", "README.md");
export const DIST_EXTENSION_INDEX = bundledDistPluginFile("demo", "index.js");
export const DIST_EXTENSION_SRC = bundledDistPluginFile("demo", "src/index.js");
export const DIST_EXTENSION_SKILL = bundledDistPluginFile("demo", "skills/SKILL.md");
export const DIST_EXTENSION_RUNTIME_SRC = "dist-runtime/extensions/demo/src/index.js";
export const DIST_RUNTIME_EXTENSION_INDEX = "dist-runtime/extensions/demo/index.js";
export const DIST_RUNTIME_EXTENSION_MANIFEST = "dist-runtime/extensions/demo/openclaw.plugin.json";
export const DIST_RUNTIME_EXTENSION_PACKAGE = "dist-runtime/extensions/demo/package.json";
export const DIST_RUNTIME_EXTENSION_SKILL = "dist-runtime/extensions/demo/skills/SKILL.md";
export const DIST_OPENCLAW_ALIAS_PACKAGE = "dist/extensions/node_modules/openclaw/package.json";
export const DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE =
  "dist/extensions/node_modules/openclaw/plugin-sdk/core.js";
export const DIST_OPENCLAW_ALIAS_PLUGIN_SDK_STRING_COERCE =
  "dist/extensions/node_modules/openclaw/plugin-sdk/string-coerce-runtime.js";
export const DIFFS_PACKAGE = "extensions/diffs/package.json";
export const DIFFS_VIEWER_RUNTIME_SOURCE = "extensions/diffs/assets/viewer-runtime.js";
export const DIST_DIFFS_VIEWER_RUNTIME = "dist/extensions/diffs/assets/viewer-runtime.js";
export const DIST_RUNTIME_DIFFS_VIEWER_RUNTIME =
  "dist-runtime/extensions/diffs/assets/viewer-runtime.js";
export const BUNDLED_HOOK_METADATA = "src/hooks/bundled/demo/HOOK.md";
export const DIST_BUNDLED_HOOK_METADATA = "dist/bundled/demo/HOOK.md";
export const DIST_EXTENSION_MANIFEST = bundledDistPluginFile("demo", "openclaw.plugin.json");
export const DIST_EXTENSION_PACKAGE = bundledDistPluginFile("demo", "package.json");

const OLD_TIME = new Date("2026-03-13T10:00:00.000Z");
const BUILD_TIME = new Date("2026-03-13T12:00:00.000Z");
export const NEW_TIME = new Date("2026-03-13T12:00:01.000Z");

const BASE_PROJECT_FILES = {
  [ROOT_TSCONFIG]: "{}\n",
  [ROOT_PACKAGE]: '{"name":"openclaw-test"}\n',
  [DIST_ENTRY]: "console.log('built');\n",
  [BUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
} as const;

export function createExitedProcess(code: number | null, signal: string | null = null) {
  return {
    on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === "exit") {
        queueMicrotask(() => cb(code, signal));
      }
      return undefined;
    },
  };
}

export function createPipedExitedProcess(params: {
  code?: number | null;
  signal?: string | null;
  stderr?: string;
  stdout?: string;
}) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return {
    stdout,
    stderr,
    on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === "exit") {
        queueMicrotask(() => {
          if (params.stdout) {
            stdout.emit("data", Buffer.from(params.stdout));
          }
          if (params.stderr) {
            stderr.emit("data", Buffer.from(params.stderr));
          }
          cb(params.code ?? 0, params.signal ?? null);
        });
      }
      return undefined;
    },
  };
}

export function createFakeProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    execPath: process.execPath,
  }) as unknown as NodeJS.Process;
}

// Launcher plumbing tests do not need the real runtime artifact copier.
export async function skipRuntimePostBuild(): Promise<void> {}

export async function syncBundledPluginMetadata(params?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  copyBundledPluginMetadata({ cwd: params?.cwd, env: params?.env });
}

export function firstMockCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T | undefined {
  return mock.mock.calls[0];
}

export async function writeRuntimePostBuildScaffold(tmp: string): Promise<void> {
  await fs.mkdir(path.join(tmp, "extensions"), { recursive: true });
  await writeProjectFiles(tmp, {
    [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
    [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
    [DIST_BUILD_INFO]: '{"buildId":"test-build"}\n',
    [DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT]: "export function resolveNodeRunner() {}\n",
    [DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT]: "export function resolveNodeRunner() {}\n",
    [DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108]: "export function resolveNodeRunner() {}\n",
    [DIST_OPENCLAW_ALIAS_PACKAGE]:
      '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/core":"./plugin-sdk/core.js"}}\n',
    [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE]: "export * from '../../../../plugin-sdk/core.js';\n",
  });
  writeUpdateCompatibilityBuildFixture(tmp);
  writeUpdateCompatibilityChunks({
    distDir: path.join(tmp, "dist"),
    sourceDir: tmp,
    inventory: previousReleaseInventory,
  });
  await touchProjectFiles(
    tmp,
    [
      DIST_CHANNEL_CATALOG,
      DIST_BUILD_INFO,
      DIST_PLUGIN_SDK_CORE,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108,
      `dist/${UPDATE_COMPATIBILITY_INVENTORY_FILE}`,
      ...previousReleaseInventory.releases.flatMap((release) =>
        release.chunks.map((chunk) => `dist/${chunk.path}`),
      ),
      DIST_OPENCLAW_ALIAS_PACKAGE,
      DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE,
    ],
    BUILD_TIME,
  );
}

export function expectedBuildSpawn() {
  return [
    process.execPath,
    "--import",
    expect.stringMatching(/\/scripts\/tsx\.mjs$/),
    expect.stringMatching(/[\\/]scripts[\\/]lib[\\/]dist-artifact-ownership\.mts$/),
    expect.stringMatching(/\/scripts\/build-all\.mts$/),
    "qaRuntime",
  ];
}

export function statusCommandSpawn() {
  return [process.execPath, "openclaw.mjs", "status"];
}

export function gatewayStatusCommandSpawn() {
  return [
    process.execPath,
    "openclaw.mjs",
    "gateway",
    "status",
    "--deep",
    "--require-rpc",
    "--json",
  ];
}

export function resolvePath(tmp: string, relativePath: string) {
  return path.join(tmp, relativePath);
}

export function isTsxScriptArgs(args: string[], scriptPath: string): boolean {
  return args[0] === "--import" && args.some((arg) => arg.endsWith(scriptPath));
}

export async function expectPathMissing(targetPath: string): Promise<void> {
  let accessError: unknown;
  try {
    await fs.access(targetPath);
  } catch (error) {
    accessError = error;
  }
  expect((accessError as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
}

async function writeProjectFiles(tmp: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const absolutePath = resolvePath(tmp, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, contents, "utf-8");
    }),
  );
}

export async function touchProjectFiles(tmp: string, relativePaths: string[], time: Date) {
  await Promise.all(
    relativePaths.map(async (relativePath) => {
      const absolutePath = resolvePath(tmp, relativePath);
      await fs.utimes(absolutePath, time, time);
    }),
  );
}

export async function setupTrackedProject(
  tmp: string,
  options: {
    files?: Record<string, string>;
    oldPaths?: string[];
    buildPaths?: string[];
    newPaths?: string[];
  } = {},
) {
  await writeRuntimePostBuildScaffold(tmp);
  await writeProjectFiles(tmp, {
    ...BASE_PROJECT_FILES,
    ...options.files,
  });
  await touchProjectFiles(tmp, options.oldPaths ?? [], OLD_TIME);
  await touchProjectFiles(tmp, options.buildPaths ?? [], BUILD_TIME);
  await touchProjectFiles(tmp, options.newPaths ?? [], NEW_TIME);
}

export async function setupStampedProject(
  tmp: string,
  options: {
    files?: Record<string, string>;
    oldPaths?: string[];
    newPaths?: string[];
    rootSource?: boolean;
    trackConfig?: boolean;
  },
): Promise<void> {
  const files = {
    ...(options.rootSource === false ? {} : { [ROOT_SRC]: "export const value = 1;\n" }),
    ...options.files,
  };
  const excludedPaths = new Set([...(options.oldPaths ?? []), ...(options.newPaths ?? [])]);
  const buildPaths = [
    ...Object.keys(files).filter((filePath) => !excludedPaths.has(filePath)),
    ...(options.trackConfig ? [ROOT_TSCONFIG, ROOT_PACKAGE] : []),
    DIST_ENTRY,
    BUILD_STAMP,
  ];
  await setupTrackedProject(tmp, {
    files,
    ...(options.oldPaths ? { oldPaths: options.oldPaths } : {}),
    buildPaths,
    ...(options.newPaths ? { newPaths: options.newPaths } : {}),
  });
}

export async function writeImmutableDeploymentManifest(tmp: string): Promise<void> {
  await writeProjectFiles(tmp, {
    [DEPLOYMENT_MANIFEST]: `${JSON.stringify({ kind: "git", sourceHead: "a".repeat(40) })}\n`,
  });
}

export function createSpawnRecorder(
  options: {
    gitHead?: string;
    gitStatus?: string;
  } = {},
) {
  const spawnCalls: string[][] = [];
  const spawn = (cmd: string, args: string[]) => {
    spawnCalls.push([cmd, ...args]);
    return createExitedProcess(0);
  };
  const spawnSync = (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse" && options.gitHead !== undefined) {
      return { status: 0, stdout: options.gitHead };
    }
    if (cmd === "git" && args[0] === "status" && options.gitStatus !== undefined) {
      return { status: 0, stdout: options.gitStatus };
    }
    return { status: 1, stdout: "" };
  };
  return { spawnCalls, spawn, spawnSync };
}

export function createCurrentGitSpawnRecorder(
  options: { gitHead?: string; gitStatus?: string } = {},
) {
  return createSpawnRecorder({ gitHead: "abc123\n", gitStatus: "", ...options });
}

export function createBuildRequirementDeps(
  tmp: string,
  options: {
    gitStatus?: string;
    env?: Record<string, string>;
  } = {},
) {
  const { spawnSync } = createCurrentGitSpawnRecorder({ gitStatus: options.gitStatus ?? "" });
  return {
    cwd: tmp,
    env: {
      ...process.env,
      ...options.env,
    },
    fs: fsSync,
    spawnSync,
    distRoot: path.join(tmp, "dist"),
    distEntry: path.join(tmp, DIST_ENTRY),
    buildStampPath: path.join(tmp, BUILD_STAMP),
    runtimePostBuildStampPath: path.join(tmp, RUNTIME_POSTBUILD_STAMP),
    sourceRoots: [path.join(tmp, "src"), path.join(tmp, bundledPluginRoot("demo"))].map(
      (sourceRoot) => ({
        name: path.relative(tmp, sourceRoot).replaceAll("\\", "/"),
        path: sourceRoot,
      }),
    ),
    configFiles: [ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN].map((filePath) =>
      path.join(tmp, filePath),
    ),
  };
}

export async function trackProjectWithGit(tmp: string) {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", `core.hooksPath=${path.join(tmp, ".git", "disabled-hooks")}`, ...args],
      { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--quiet", "--template=");
  git("config", "core.quotePath", "true");
  git("add", "--all");
  git(
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@openclaw.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "test: track runner fixture",
  );
  writeBuildStamp({ cwd: tmp, spawnSync: realSpawnSync });
  writeRuntimePostBuildStamp({ cwd: tmp, spawnSync: realSpawnSync });
  await touchProjectFiles(tmp, [BUILD_STAMP, RUNTIME_POSTBUILD_STAMP], BUILD_TIME);
  return {
    git,
    deps: { ...createBuildRequirementDeps(tmp), env: {}, spawnSync: realSpawnSync },
  };
}

type RunNodeTestOptions = NonNullable<Parameters<typeof runNodeMain>[0]> & {
  stdout?: NodeJS.WriteStream;
};
type RunNodeResult = Awaited<ReturnType<typeof runNodeMain>>;

export async function runNodeCommand(
  tmp: string,
  options: RunNodeTestOptions,
): Promise<RunNodeResult> {
  const { env, ...overrides } = options;
  return await runNodeMain({
    cwd: tmp,
    args: ["status"],
    ...overrides,
    env: { ...process.env, OPENCLAW_RUNNER_LOG: "0", ...env },
    execPath: process.execPath,
    platform: options.platform ?? process.platform,
  } as RunNodeTestOptions);
}

type RunCommandParams = {
  tmp: string;
  args?: string[];
  spawn: (cmd: string, args: string[]) => ReturnType<typeof createExitedProcess>;
  spawnSync?: (cmd: string, args: string[]) => { status: number; stdout: string };
  stderr?: NodeJS.WriteStream;
  env?: Record<string, string>;
  runRuntimePostBuild?: (params?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }) => void | Promise<void>;
};

export async function runStatusCommand({
  tmp,
  ...options
}: RunCommandParams): Promise<RunNodeResult> {
  return await runNodeCommand(tmp, options);
}

export async function runQaCommand(params: RunCommandParams): Promise<RunNodeResult> {
  return await runStatusCommand({
    ...params,
    args: ["qa", "suite", "--transport", "qa-channel", "--provider-mode", "mock-openai"],
  });
}

export async function expectManifestId(tmp: string, relativePath: string, id: string) {
  const manifest = JSON.parse(await fs.readFile(resolvePath(tmp, relativePath), "utf-8")) as {
    id?: unknown;
  };
  expect(manifest.id).toBe(id);
}
