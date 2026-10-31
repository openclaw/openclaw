import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  mkdtempSync,
  openSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { ANCHOR_PREFIX, withDependencyCacheLock } from "../../scripts/pr-lib/cache-lifetime.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";

// A policy launcher deliberately discovers its backend with bare Git. Bound
// depth makes an adapter cycle a deterministic failure, never a process storm.
export function delegatingGitFixture<TEnv extends NodeJS.ProcessEnv>(
  root: string,
  parentEnv: TEnv,
) {
  const selected = join(root, "policy git'launcher");
  const calls = join(root, "policy-git-calls");
  writeFileSync(
    selected,
    `#!/bin/sh
depth=\${PR_TEST_GIT_DEPTH:-0}
if [ "$depth" -ge 3 ]; then echo 'recursive selected Git' >&2; exit 86; fi
export PR_TEST_GIT_DEPTH=$((depth + 1))
printf '%s %s\\n' "\${PR_TEST_GIT_PHASE:-bootstrap}" "$*" >> "$PR_TEST_GIT_CALLS"
exec git "$@"
`,
    { mode: 0o755 },
  );
  return {
    selected,
    calls,
    env: {
      ...parentEnv,
      OPENCLAW_PR_GIT: selected,
      GIT_EXEC: selected,
      PR_TEST_GIT_CALLS: calls,
      PR_TEST_GIT_DEPTH: "0",
    },
  };
}

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

export function copyPrRoutingWrapperSources(destination: string) {
  // Routing and supervision use wrapper tooling; app-import fixtures keep the full inventory.
  // Keep the local-check component for the unanchored fixture's trust-drift assertions.
  const components = [
    "package.json",
    "scripts/lib/plain-gh.sh",
    "scripts/lib/plain-gh.mjs",
    "scripts/lib/direct-run.mjs",
    "scripts/lib/managed-child-process.mts",
    "scripts/lib/managed-cleanup-handoff.mts",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/vitest-resource-ownership.mts",
    "scripts/lib/windows-taskkill.mjs",
    "scripts/lib/local-check-runtime.mts",
  ];
  mkdirSync(join(destination, "scripts/lib"), { recursive: true });
  for (const component of ["scripts/pr", "scripts/pr-lib", ...components]) {
    cpSync(component, join(destination, component), { recursive: true });
  }
  writeFileSync(
    join(destination, "scripts/pr-lib/wrapper-components.txt"),
    `${components.join("\n")}\n`,
  );
}

export function linkPrWrapperDependencies(destination: string): void {
  // Fixture initialization may repeat; stale-base squash merges have reintroduced
  // duplicate initialization twice.
  const modulesDir = join(destination, "node_modules");
  mkdirSync(modulesDir, { recursive: true });
  // Use installed third-party packages only, never workspace source or loader mocks.
  for (const dependency of [
    "@openclaw/fs-safe",
    "@openclaw/proc-safe",
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
    "kysely",
    "minimatch",
    "p-map",
    "partial-json",
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
  for (const dependency of [
    "mdast-util-from-markdown",
    "mdast-util-gfm-table",
    "micromark",
    "micromark-extension-gfm-table",
  ]) {
    const linkedDependency = join(destination, "packages/markdown-core/node_modules", dependency);
    mkdirSync(dirname(linkedDependency), { recursive: true });
    if (!lstatSync(linkedDependency, { throwIfNoEntry: false })) {
      symlinkSync(
        realpathSync(join("packages/markdown-core/node_modules", dependency)),
        linkedDependency,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
}

// Fixture readiness and settlement come from the real producer/creator owners,
// never handcrafted ledger rows. The child receives only its own directory FD.
export function createSettledPrCacheEntry(
  cache: string,
  key: string,
  runtime = requireNodeTool("node"),
) {
  withDependencyCacheLock(cache, () => {});
  const home = resolve(cache, "../../../..");
  const anchor = join(dirname(cache), `${ANCHOR_PREFIX}${process.pid}.${randomUUID()}`);
  mkdirSync(anchor, { mode: 0o700 });
  const stage = mkdtempSync(join(cache, `install-${process.pid}-`));
  const entry = join(cache, key);
  const fd = openSync(anchor, "r");
  try {
    const source = pathToFileURL(resolve("scripts/pr-lib/cache-lifetime.mjs")).href;
    const result = spawnSync(
      runtime,
      [
        "--input-type=module",
        "-e",
        `
import { rmSync } from "node:fs";
import { claimCreatedAnchor, publishDependencyCache, retireAnchorDependencies, withDependencyCacheLock } from ${JSON.stringify(source)};
const anchor = claimCreatedAnchor(process.argv[1], process.ppid);
withDependencyCacheLock(process.argv[2], lock => publishDependencyCache(lock, process.argv[3], process.argv[4], anchor));
retireAnchorDependencies(anchor, () => rmSync(anchor.path, { recursive: true }));
`,
        anchor,
        cache,
        stage,
        entry,
      ],
      {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          fd,
        ],
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || "Fixture cache publication failed");
    }
  } finally {
    closeSync(fd);
  }
  return entry;
}

export function prCacheEntries(cache: string) {
  return readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name));
}

export function readPrCacheState(entry: string) {
  const db = new DatabaseSync(join(dirname(entry), "lifetime.sqlite"), { readOnly: true });
  try {
    const key = basename(entry);
    const installation = db.prepare("SELECT settled FROM installations WHERE key = ?").get(key);
    const holds = db
      .prepare("SELECT anchor_path FROM holds WHERE entry_key = ? ORDER BY anchor_path")
      .all(key);
    return {
      registered: Boolean(installation),
      settled: installation?.settled === 1,
      anchors: holds.map((row) => String(row.anchor_path)),
    };
  } finally {
    db.close();
  }
}
