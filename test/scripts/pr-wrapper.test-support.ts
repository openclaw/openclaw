import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export function createIndependentPrFixtureEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  // Independent fixtures own wrapper routing, Git selection, and supervisor bindings.
  for (const key of Object.keys(env)) {
    if (key === "GIT_EXEC" || key.startsWith("OPENCLAW_PR_")) {
      delete env[key];
    }
  }
  return env;
}

export function copyPrWrapperSources(destination: string): string[] {
  // Keep fixture sources and commits on the production inventory. Extracted
  // execution tests catch missing dependencies without a second source list.
  const components = [
    "scripts/pr",
    "scripts/pr-lib",
    ...readFileSync("scripts/pr-lib/wrapper-components.txt", "utf8").trim().split("\n"),
  ];
  for (const component of components) {
    mkdirSync(dirname(join(destination, component)), { recursive: true });
    cpSync(component, join(destination, component), { recursive: true });
  }
  return components;
}

export function linkPrWrapperDependencies(destination: string): void {
  // Fixture initialization may repeat; stale-base squash merges have reintroduced
  // duplicate initialization twice.
  const modulesDir = join(destination, "node_modules");
  mkdirSync(modulesDir, { recursive: true });
  // Use installed third-party packages only, never workspace source or loader mocks.
  for (const dependency of [
    "@openclaw/fs-safe",
    "@openclaw/proxyline",
    "acorn",
    "chalk",
    "commander",
    "dotenv",
    "execa",
    "hosted-git-info",
    "import-meta-resolve",
    "ipaddr.js",
    "jiti",
    "json5",
    "koffi",
    "kysely",
    "minimatch",
    "ms",
    "p-map",
    "semver",
    "string-width",
    "tsdown",
    "tslog",
    "tsx",
    "typebox",
    "typescript",
    "undici",
    "yaml",
    "zod",
  ]) {
    const linkedDependency = join(modulesDir, dependency);
    mkdirSync(dirname(linkedDependency), { recursive: true });
    if (lstatSync(linkedDependency, { throwIfNoEntry: false })) {
      continue;
    }
    symlinkSync(
      realpathSync(join("node_modules", dependency)),
      linkedDependency,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}
