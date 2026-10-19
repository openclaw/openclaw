// Threads inherit admission; forks also run this bootstrap in their own process.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteUserConfig } from "vitest/config";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { resolveTsxImport } from "../../scripts/lib/tsx-cli-shim.mjs";
import {
  isCiLikeEnv,
  resolveLocalVitestScheduling,
} from "../../scripts/lib/vitest-local-scheduling.mts";
import type { LocalVitestScheduling } from "../../scripts/lib/vitest-local-scheduling.mts";
import { resolveTestBunSourceArgs } from "../../src/test-utils/bun-process.ts";
import { controlUiSolidPlugin } from "../../ui/config/control-ui-solid.ts";
import {
  BUNDLED_PLUGIN_ROOT_DIR,
  BUNDLED_PLUGIN_TEST_GLOB,
} from "./vitest.bundled-plugin-paths.ts";
import { sharedVitestExcludePatterns } from "./vitest.pattern-file.ts";
import {
  createVitestProjectCachePlugin,
  loadVitestPerformanceConfig,
} from "./vitest.performance-config.ts";
import { createRedactingReporterPlugin } from "./vitest.reporters.ts";
import { createVitestResolveConfig } from "./vitest.resolve.ts";
import { shouldPrintVitestThrottle } from "./vitest.system-load.ts";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest.timeouts.ts";
import { compiledSubprocessesPlugin } from "./vitest.worker-artifacts.ts";

if (process.versions.bun) {
  await import("./vitest.sqlite-preload.mts");
}

export type { LocalVitestScheduling };

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const nonIsolatedRunnerPath = path.join(repoRoot, "test", "non-isolated-runner.ts");
const vitestConfigFiles = fs
  .readdirSync(path.join(repoRoot, "test", "vitest"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:mjs|mts|ts)$/u.test(entry.name))
  .map((entry) => `test/vitest/${entry.name}`)
  .toSorted((left, right) => left.localeCompare(right));
export function resolveRepoRootPath(value: string): string {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}
const isCI = isCiLikeEnv(process.env);
const isWindows = process.platform === "win32";
const localScheduling = resolveLocalVitestScheduling();

function hasWorkerOverride(env: Record<string, string | undefined>): boolean {
  return Boolean((env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS)?.trim());
}

export function resolveSharedVitestWorkerConfig(params: {
  env?: Record<string, string | undefined>;
  isCI?: boolean;
  isWindows?: boolean;
  localScheduling?: LocalVitestScheduling;
}): Pick<LocalVitestScheduling, "fileParallelism" | "maxWorkers"> & {
  pool: "forks" | "threads";
} {
  const env = params.env ?? process.env;
  const local = params.localScheduling ?? localScheduling;
  const windows = params.isWindows ?? isWindows;
  // Windows concurrent thread spawns can inherit one another's temporary pipe
  // handles. Separate processes keep those writers out of unrelated child trees.
  const pool = windows ? "forks" : "threads";
  if (hasWorkerOverride(env)) {
    return {
      pool,
      fileParallelism: local.fileParallelism,
      maxWorkers: local.maxWorkers,
    };
  }
  if (params.isCI ?? isCI) {
    return {
      pool,
      fileParallelism: true,
      maxWorkers: windows ? 2 : 3,
    };
  }
  return {
    pool,
    fileParallelism: local.fileParallelism,
    maxWorkers: local.maxWorkers,
  };
}

const workerConfig = resolveSharedVitestWorkerConfig({
  env: process.env,
  isCI,
  isWindows,
  localScheduling,
});
const dependencyModuleDirectories = ["/node_modules/", "/openclaw-pnpm-node-modules/"];
const dependencyExternalPatterns = [
  /\/openclaw-pnpm-node-modules\/(?!.*\/?vite\w*\/dist\/client\/env\.mjs$).*\.(?:cjs\.js|mjs)$/u,
];
if (!isCI && localScheduling.throttledBySystem && shouldPrintVitestThrottle(process.env)) {
  console.error(
    `[vitest] throttling local workers to ${localScheduling.maxWorkers}${
      localScheduling.fileParallelism ? "" : " with file parallelism disabled"
    } because the host already looks busy.`,
  );
}

export const sharedVitestConfig = {
  root: repoRoot,
  envDir: false as const,
  plugins: [
    {
      name: "openclaw:node-worker-policy",
      config: {
        order: "pre" as const,
        handler: (config: ViteUserConfig) => ({
          test: {
            // Generated projects may copy plugins without the shared test block.
            environment: config.test?.environment ?? "node",
            globalSetup: [resolveRepoRootPath("test/vitest/vitest.node-policy.global-setup.ts")],
          },
        }),
      },
    },
    // Node tests also import UI renderers. Keep their compiler off non-UI sources.
    ...controlUiSolidPlugin([
      `${repoRoot.replaceAll("\\", "/")}/ui/**/*.tsx`,
      `${repoRoot.replaceAll("\\", "/")}/extensions/*/browser/**/*.tsx`,
    ]),
    createStateSchemaInlinePlugin(repoRoot),
    compiledSubprocessesPlugin(),
    createVitestProjectCachePlugin(),
    createRedactingReporterPlugin(),
  ],
  resolve: createVitestResolveConfig(repoRoot),
  test: {
    dir: repoRoot,
    root: repoRoot,
    // Solid defaults unspecified test environments to jsdom; preserve Node's default.
    environment: "node",
    // Emit completed cases even under agent detection so healthy runs feed the output watchdog.
    reporters: ["verbose", ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : [])],
    testTimeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
    // Preserve calls recorded during shared setup and beforeAll hooks.
    clearMocks: false,
    // 180s on every platform: GitHub-hosted 4-core fallback runners (Blacksmith
    // outage breaker) push e2e beforeAll hooks past 120s; Windows always needed it.
    hookTimeout: 180_000,
    unstubEnvs: true,
    unstubGlobals: true,
    isolate: false,
    pool: workerConfig.pool,
    // Native imports keep the invocation owner's isolated source-cache policy.
    execArgv: [
      ...(process.versions.bun
        ? resolveTestBunSourceArgs(repoRoot)
        : ["--import", resolveTsxImport(repoRoot)]),
      // Bun's Windows preload resolver requires a filesystem path instead of a file URL.
      process.versions.bun
        ? `--preload=${fileURLToPath(new URL("./vitest.jsdom-preload.mts", import.meta.url))}`
        : `--import=${new URL("./vitest.jsdom-preload.mts", import.meta.url).href}`,
    ],
    runner: nonIsolatedRunnerPath,
    maxWorkers: workerConfig.maxWorkers,
    fileParallelism: workerConfig.fileParallelism,
    deps: {
      moduleDirectories: dependencyModuleDirectories,
    },
    server: {
      deps: {
        // Vite versions unoptimized imports; native transitive imports do not.
        // Keep editor classes and parser properties in one module graph.
        inline: [/@(?:codemirror|lezer)\//u],
        external: dependencyExternalPatterns,
      },
    },
    // Vitest matches these with picomatch against absolute changed-file paths, so every entry
    // must resolve absolute; relative entries silently never match. Explicit lane files keep
    // watcher registration working (chokidar v4+ ignores globs in watcher.add) while the glob
    // keeps match coverage for files added after config load.
    forceRerunTriggers: [
      "package.json",
      "pnpm-lock.yaml",
      "vitest.config.ts",
      "test/setup.ts",
      "test/setup.env.ts",
      "test/setup.shared.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
      ...vitestConfigFiles,
      "test/vitest/**/*.{ts,mts,mjs}",
    ].map(resolveRepoRootPath),
    include: [
      "src/**/*.test.ts",
      BUNDLED_PLUGIN_TEST_GLOB,
      "packages/**/*.test.ts",
      "test/**/*.test.ts",
      "ui/src/pages/chat/tool-stream.node.test.ts",
    ],
    setupFiles: [resolveRepoRootPath("test/setup.ts")],
    exclude: [...sharedVitestExcludePatterns],
    coverage: {
      provider: "v8" as const,
      reporter: ["text", "lcov"],
      all: false,
      exclude: [
        `${BUNDLED_PLUGIN_ROOT_DIR}/**`,
        "apps/**",
        "ui/**",
        "test/**",
        "src/**/*.test.ts",
        "src/entry.ts",
        "src/index.ts",
        "src/runtime.ts",
        "src/logging.ts",
        "src/cli/**",
        "src/commands/**",
        "src/daemon/**",
        "src/hooks/**",
        "src/macos/**",
        "src/acp/**",
        "src/agents/**",
        "src/channels/**",
        "src/gateway/**",
        "src/line/**",
        "src/media-understanding/**",
        "src/node-host/**",
        "src/plugins/**",
        "src/providers/**",
        "src/secrets/**",
        "src/agents/model-scan.ts",
        "src/agents/embedded-agent-runner.ts",
        "src/agents/sandbox-paths.ts",
        "src/agents/sandbox.ts",
        "src/agents/agent-tool-definition-adapter.ts",
        "src/agents/tools/discord-actions*.ts",
        "src/infra/update-check.ts",
        "src/infra/ports-inspect.ts",
        "src/infra/outbound/outbound-session.ts",
        "src/gateway/control-ui.ts",
        "src/gateway/server-channels.ts",
        "src/gateway/server-methods/config.ts",
        "src/gateway/server-methods/send.ts",
        "src/gateway/server-methods/skills.ts",
        "src/gateway/talk/handlers/index.ts",
        "src/gateway/server-methods/web.ts",
        "src/gateway/server-methods/wizard.ts",
        "src/gateway/call.ts",
        "src/process/exec.ts",
        "src/tui/**",
        "src/wizard/**",
        "src/browser/**",
        "src/webchat/**",
        "src/gateway/server.ts",
        "src/gateway/client.ts",
        "packages/gateway-protocol/src/**",
        "src/infra/tailscale.ts",
      ],
    },
    ...loadVitestPerformanceConfig(process.env, process.platform, repoRoot),
  },
};
