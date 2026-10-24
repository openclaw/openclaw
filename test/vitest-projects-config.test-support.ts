// Stateful Vitest project inventory helpers run in the isolated unit-fast lane.
import { globSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { globSync as nativeGlobSync } from "tinyglobby";
import { withEnvAsync } from "../src/test-utils/env.js";
import { fullSuiteVitestShards } from "./vitest/vitest.test-shards.mjs";

type VitestConfig = {
  root?: string;
  test?: {
    dir?: string;
    exclude?: string[];
    include?: string[];
    projects?: Array<string | VitestConfig>;
  };
};

type VitestConfigFactory = (env?: Record<string, string | undefined>) => VitestConfig;

let configImportId = 0;

const toRepoPath = (filePath: string) => filePath.replaceAll("\\", "/");

export async function listVitestConfigTestFiles(
  configPath: string,
  includeFile?: string,
): Promise<string[]> {
  const config = await withEnvAsync({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }, async () => {
    const previousArgv = process.argv;
    process.argv = [previousArgv[0] ?? "node", previousArgv[1] ?? "vitest"];
    try {
      const configUrl = pathToFileURL(path.resolve(process.cwd(), configPath));
      // Focused runs may have cached a CLI-narrowed default config before the audit clears argv.
      configUrl.searchParams.set("openclaw-vitest-ownership-audit", String(configImportId++));
      const mod = (await import(configUrl.href)) as Record<string, unknown>;
      const defaultConfig = (mod.default ?? {}) as VitestConfig;
      const factory = Object.entries(mod).find(
        ([name, value]) =>
          name !== "default" && /^create.*VitestConfig$/u.test(name) && typeof value === "function",
      )?.[1] as VitestConfigFactory | undefined;
      return defaultConfig.test?.projects
        ? defaultConfig
        : (factory?.(process.env) ?? defaultConfig);
    } finally {
      process.argv = previousArgv;
    }
  });
  return listConfigTestFiles(config, includeFile);
}

async function listConfigTestFiles(config: VitestConfig, includeFile?: string): Promise<string[]> {
  const testConfig = config.test ?? {};
  if (testConfig.projects) {
    const projects = [];
    for (const project of testConfig.projects) {
      projects.push(
        ...(typeof project === "string"
          ? await listVitestConfigTestFiles(project, includeFile)
          : await listConfigTestFiles(project, includeFile)),
      );
    }
    return projects;
  }
  const dir = path.resolve(config.root ?? process.cwd(), testConfig.dir ?? ".");
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    path.isAbsolute(pattern) ? toRepoPath(path.relative(dir, pattern)) : toRepoPath(pattern),
  );
  return nativeGlobSync(testConfig.include ?? [], {
    cwd: dir,
    ignore: exclude,
    dot: true,
    expandDirectories: false,
  }).map((file) => toRepoPath(path.relative(process.cwd(), path.resolve(dir, file))));
}

export async function auditFullSuiteTestFileOwnership(): Promise<{
  duplicated: string[];
  missing: string[];
}> {
  const files = globSync(["**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], {
    cwd: process.cwd(),
    exclude: ["**/.*/**", "**/dist/**", "**/node_modules/**", "**/vendor/**"],
  })
    .map(toRepoPath)
    .filter(
      (file) =>
        !file.includes(".live.test.") &&
        !file.includes(".e2e.test.") &&
        !file.startsWith("test/fixtures/") &&
        // Browser retention probes belong to their opt-in census config.
        !file.startsWith("scripts/control-ui-retention/") &&
        file !== "src/gateway/gateway.test.ts",
    )
    .toSorted((left, right) => left.localeCompare(right));
  const matches = new Map<string, string[]>();
  for (const configPath of new Set(fullSuiteVitestShards.flatMap((shard) => shard.projects))) {
    for (const repoPath of await listVitestConfigTestFiles(configPath)) {
      matches.set(repoPath, [...(matches.get(repoPath) ?? []), configPath]);
    }
  }
  return {
    missing: files.filter((file) => !matches.has(file)),
    duplicated: [...matches.entries()]
      .filter(([, configs]) => configs.length > 1)
      .map(([file, configs]) => `${file}: ${configs.join(", ")}`)
      .toSorted((left, right) => left.localeCompare(right)),
  };
}
