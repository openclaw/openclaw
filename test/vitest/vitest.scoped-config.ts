// Vitest scoped config helper builds test configs for scoped file patterns.
import path from "node:path";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { diagnosticForksPool } from "./vitest.forks-pool.ts";
import { matchesVitestGlob } from "./vitest.pattern-file.ts";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import {
  nonIsolatedRunnerPath,
  repoRoot,
  resolveRepoRootPath,
  sharedVitestConfig,
} from "./vitest.shared.config.ts";

function normalizePathPattern(value: string): string {
  return value.replaceAll("\\", "/");
}

function globRoot(pattern: string): string | null {
  const globStart = pattern.search(/[*{[]/u);
  if (globStart < 0) {
    return null;
  }
  const slashBeforeGlob = pattern.lastIndexOf("/", globStart);
  if (slashBeforeGlob < 0) {
    return "";
  }
  return pattern.slice(0, slashBeforeGlob);
}

function directoryPatternCoversInclude(excludePattern: string, includePattern: string): boolean {
  if (!excludePattern.endsWith("/**")) {
    return false;
  }
  const excludeRoot = excludePattern.slice(0, -"/**".length);
  const includeRoot = globRoot(includePattern);
  const candidate = includeRoot ?? includePattern;
  return candidate === excludeRoot || candidate.startsWith(`${excludeRoot}/`);
}

function includePatternIsFullyExcluded(includePattern: string, excludePattern: string): boolean {
  const include = normalizePathPattern(includePattern);
  const exclude = normalizePathPattern(excludePattern);
  return (
    include === exclude ||
    matchesVitestGlob(include, exclude) ||
    directoryPatternCoversInclude(exclude, include)
  );
}

export function shouldPassWithNoTestsForCliIncludes(
  cliIncludePatterns: string[] | null,
  excludePatterns: string[],
): boolean {
  if (cliIncludePatterns === null) {
    return false;
  }
  return cliIncludePatterns.every((includePattern) =>
    excludePatterns.some((excludePattern) =>
      includePatternIsFullyExcluded(includePattern, excludePattern),
    ),
  );
}

const SCOPED_PROJECT_GROUP_ORDER_BY_NAME = new Map(
  [
    "acp",
    "agents",
    "agents-core",
    "agents-embedded-agent",
    "agents-embedded-agent-incomplete-turn",
    "agents-embedded-agent-overflow-compaction",
    "agents-embedded-agent-run",
    "agents-support",
    "agents-tools",
    "auto-reply",
    "auto-reply-core",
    "auto-reply-reply",
    "auto-reply-top-level",
    "boundary",
    "bundled",
    "channels",
    "cli-process",
    "cli",
    "commands",
    "commands-light",
    "cron",
    "daemon",
    "extension-active-memory",
    "extension-acpx",
    "extension-channels",
    "extension-codex",
    "extension-diffs",
    "extension-discord",
    "extension-feishu",
    "extension-imessage",
    "extension-irc",
    "extension-line",
    "extension-mattermost",
    "extension-matrix",
    "extension-media",
    "extension-memory",
    "extension-messaging",
    "extension-msteams",
    "extension-provider-openai",
    "extension-providers",
    "extension-signal",
    "extension-slack",
    "extension-database-workers",
    "extension-telegram",
    "extension-voice-call",
    "extension-whatsapp",
    "extension-zalo",
    "extensions",
    "gateway",
    "gateway-methods-isolated",
    "hooks",
    "infra",
    "logging",
    "media",
    "media-understanding",
    "plugin-sdk",
    "plugin-sdk-light",
    "plugins",
    "process",
    "runtime-config",
    "secrets",
    "shared-core",
    "tooling-docker",
    "tooling-isolated",
    "tooling",
    "tui",
    "ui",
    "ui-e2e",
    "unit-fast",
    "unit-security",
    "unit-src",
    "unit-support",
    "utils",
    "wizard",
  ].map((name, index) => [name, index + 10]),
);

function hashFallbackScopedProjectGroupOrder(key: string): number {
  let hash = 0;
  for (const char of key) {
    hash = (hash * 33 + char.charCodeAt(0)) % 10_000;
  }
  return hash + 1_000;
}

function resolveScopedProjectGroupOrder(
  name?: string,
  dir?: string,
  include?: string[],
): number | undefined {
  const normalizedName = name?.trim();
  if (normalizedName) {
    return (
      SCOPED_PROJECT_GROUP_ORDER_BY_NAME.get(normalizedName) ??
      hashFallbackScopedProjectGroupOrder(normalizedName)
    );
  }
  const normalizedInclude = include?.map(normalizePathPattern).join("|") ?? "";
  const key = [dir?.trim(), normalizedInclude].filter(Boolean).join("|");
  if (!key) {
    return undefined;
  }
  return hashFallbackScopedProjectGroupOrder(key);
}

export function createScopedVitestConfig(
  include: string[],
  options?: {
    deps?: Record<string, unknown>;
    dir?: string;
    env?: Record<string, string | undefined>;
    environment?: string;
    exclude?: string[];
    execArgv?: string[];
    argv?: string[];
    includeOpenClawRuntimeSetup?: boolean;
    isolate?: boolean;
    name?: string;
    fileParallelism?: boolean;
    hookTimeout?: number;
    intersectIncludeFile?: boolean;
    pool?: "forks" | "threads";
    passWithNoTests?: boolean;
    excludeUnitFastTests?: boolean;
    setupFiles?: string[];
    useNonIsolatedRunner?: boolean;
  },
  // Explicit nameable return type: inference otherwise reaches vite-internal
  // names (TS4058/TS4082) in every downstream scoped-config creator.
): ViteUserConfig {
  const base = sharedVitestConfig as Record<string, unknown>;
  const baseTest = sharedVitestConfig.test ?? {};
  const baseSequence = (baseTest as { sequence?: { groupOrder?: number } }).sequence;
  const scopedDir = options?.dir;
  const resolvedScopedDir = scopedDir ? path.join(repoRoot, scopedDir) : undefined;
  const isolate = options?.isolate ?? false;
  const setupFiles = [
    ...new Set([
      ...(baseTest.setupFiles ?? []),
      ...(options?.setupFiles ?? []),
      ...(options?.includeOpenClawRuntimeSetup === false ? [] : ["test/setup-openclaw-runtime.ts"]),
    ]),
  ].map(resolveRepoRootPath);
  const useNonIsolatedRunner = options?.useNonIsolatedRunner ?? !isolate;
  const runner = useNonIsolatedRunner ? nonIsolatedRunnerPath : undefined;
  const scopedGroupOrder = resolveScopedProjectGroupOrder(options?.name, scopedDir, include);

  return defineConfig({
    ...base,
    plugins: [
      ...sharedVitestConfig.plugins,
      createScopedVitestPatternPlugin(
        include,
        options ?? {},
        baseTest.exclude ?? [],
        (patterns, test) =>
          test.passWithNoTests === undefined &&
          ((patterns.externalIncludePatterns !== null &&
            shouldPassWithNoTestsForCliIncludes(
              patterns.scopedEnvInclude,
              patterns.scopedExclude,
            )) ||
            shouldPassWithNoTestsForCliIncludes(patterns.scopedCliInclude, patterns.scopedExclude))
            ? { passWithNoTests: true }
            : {},
      ),
    ],
    test: {
      ...withoutVitestPatternFields(baseTest),
      ...(options?.deps ? { deps: options.deps } : {}),
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.environment ? { environment: options.environment } : {}),
      ...(options?.execArgv ? { execArgv: options.execArgv } : {}),
      isolate,
      ...(runner ? { runner } : { runner: undefined }),
      setupFiles,
      ...(resolvedScopedDir ? { dir: resolvedScopedDir } : {}),
      ...(options?.pool
        ? {
            pool:
              options.pool === "forks" && (scopedDir === "extensions" || options.name === "infra")
                ? diagnosticForksPool
                : options.pool,
          }
        : {}),
      ...(options?.fileParallelism === undefined
        ? {}
        : { fileParallelism: options.fileParallelism }),
      ...(options?.hookTimeout === undefined ? {} : { hookTimeout: options.hookTimeout }),
      ...(scopedGroupOrder === undefined
        ? {}
        : {
            sequence: {
              ...baseSequence,
              groupOrder: scopedGroupOrder,
            },
          }),
      ...(options?.passWithNoTests !== undefined
        ? { passWithNoTests: options.passWithNoTests }
        : {}),
    },
  });
}
