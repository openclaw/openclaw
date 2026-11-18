// Runtime controls shared by Node test owners, without application transforms.
import "../helpers/postgres-pool-roots.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteUserConfig } from "vitest/config";
import { resolveTsxImport } from "../../scripts/lib/tsx-cli-shim.mjs";
import {
  isCiLikeEnv,
  resolveLocalVitestScheduling,
} from "../../scripts/lib/vitest-local-scheduling.mts";
import type { LocalVitestScheduling } from "../../scripts/lib/vitest-local-scheduling.mts";
import { resolveTestBunSourceArgs } from "../../src/test-utils/bun-process.ts";
import {
  createVitestProjectCachePlugin,
  loadVitestPerformanceConfig,
} from "./vitest.performance-config.ts";
import { createRedactingReporterPlugin } from "./vitest.reporters.ts";
import { shouldPrintVitestThrottle } from "./vitest.system-load.ts";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest.timeouts.ts";

if (process.versions.bun) {
  await import("./vitest.sqlite-preload.mts");
}

export type { LocalVitestScheduling };

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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

export const nodeVitestConfig = {
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
    createVitestProjectCachePlugin(),
    createRedactingReporterPlugin(),
  ],
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
    ...loadVitestPerformanceConfig(process.env, process.platform, repoRoot),
  },
};
