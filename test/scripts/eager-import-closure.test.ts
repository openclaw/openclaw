import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { listDirectoryTreeStrictSync } from "../../src/infra/directory-walk.js";
import { createRuntimeProcessEntrypoints } from "../../src/infra/runtime-process-manifest.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { prepareCopiedSourceModules } from "./copied-source-modules.test-support.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itPosix = process.platform === "win32" ? it.skip : it;
const wrapperInventory = "scripts/pr-lib/wrapper-components.txt";
const inventoryCheck =
  'pnpm test test/scripts/eager-import-closure.test.ts -t "PR wrapper inventory"';
const wrapperFailure = (output: string) =>
  `${output}\nCheck the inventory first: ${inventoryCheck}`;
const filesUnder = (root: string) =>
  listDirectoryTreeStrictSync(root)
    .map((entry) => entry.dirent)
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

function run(
  command: string,
  args: string[],
  options: Pick<SpawnSyncOptions, "cwd" | "env" | "timeout"> = {},
) {
  return spawnSync(command, args, { ...options, encoding: "utf8" });
}

function expectResult(
  result: ReturnType<typeof run>,
  expected: { status: number; stdout?: unknown; stderr?: unknown },
) {
  expect(result, wrapperFailure(result.stderr)).toMatchObject(expected);
}

function wrapperFixture() {
  const root = tempDirs.make("openclaw-pr-anchor-");
  const canonical = join(root, "canonical");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = run(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd, env },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  return { root, canonical, env, git };
}

function writeFixture(root: string, files: Record<string, unknown>) {
  for (const [file, value] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  }
}

function replaceFsSafe(root: string, canonical: string, manifest: Record<string, unknown>) {
  const dependency = join(root, "fixture-fs-safe");
  writeFixture(dependency, { "package.json": manifest, "config.js": "export {};\n" });
  const installed = join(canonical, "node_modules/@openclaw/fs-safe");
  rmSync(installed);
  symlinkSync(dependency, installed, process.platform === "win32" ? "junction" : "dir");
}

it("keeps packaged scripts closed over runtime imports", () => {
  const files: string[] = JSON.parse(readFileSync("package.json", "utf8")).files;
  const scripts = files.filter(
    (file) => file.startsWith("scripts/") && !/\.d\.[cm]?ts$/.test(file),
  );
  const closure = collectRuntimeImportClosure(process.cwd(), scripts, {
    includeDynamicImports: true,
  });
  expect(
    closure.filter((file) => !files.includes(file)),
    "Package lifecycle scripts must ship their guarded imports and transitive dependencies.",
  ).toEqual([]);
});

it("keeps the PR wrapper inventory closed over runtime imports", () => {
  const components = readFileSync(wrapperInventory, "utf8").trim().split("\n");
  const stale = components.filter((file) => !existsSync(file)).toSorted();
  // scripts/pr archives all of pr-lib implicitly. Other inventory entries also
  // seed the graph: shell-launched helpers and workers are not ordinary imports.
  const closure = collectRuntimeImportClosure(process.cwd(), [
    ...filesUnder("scripts/pr-lib"),
    ...components.filter((file) => existsSync(file)),
  ]);
  // Forked children resolve through the process manifest, not an import edge. Wrapper
  // processes never select PostgreSQL, so its bridge (and unpinned pg) stays unextracted.
  const entrypoints = new Map(Object.entries(createRuntimeProcessEntrypoints(import.meta.url)));
  entrypoints.delete("postgresBridge");
  const forked = closure.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/resolveRuntimeProcessEntrypointUrl\(([^)]*)\)/g)]
      .flatMap(([, argument]) => Array.from(argument!.matchAll(/"(\w+)"/g)))
      .flatMap(([, name]) => {
        const entry = entrypoints.get(name!);
        return entry ? [posix.join("src/infra", `${entry.sourceWorkerName}.ts`)] : [];
      }),
  );
  const extracted = new Set(["scripts/pr", ...components]);
  const missing = [...new Set([...closure, ...forked])].filter(
    (file) => !file.startsWith("scripts/pr-lib/") && !extracted.has(file),
  );
  // Existing assets can be path-loaded; only absent inventory paths are stale.
  const diagnostic = [
    "The trusted-anchor PR wrapper extracts only scripts/pr, scripts/pr-lib, and its inventory.",
    `Missing runtime imports (add to ${wrapperInventory}):\n${missing.join("\n")}`,
    `Stale paths (remove from ${wrapperInventory}):\n${stale.join("\n")}`,
    `Run locally: ${inventoryCheck}`,
  ].join("\n");
  expect({ missing, stale }, diagnostic).toEqual({ missing: [], stale: [] });
});

it("acquires wrapper leases and manages templates without the application command runtime", async () => {
  const root = tempDirs.make("openclaw-pr-lease-bootstrap-");
  copyPrWrapperSources(root);
  linkPrWrapperDependencies(root);
  await prepareCopiedSourceModules(root, [
    "src/agents/worktrees/allocation.ts",
    "src/agents/worktrees/template-registry-async.ts",
    "src/state/openclaw-state-lease.ts",
    "src/state/openclaw-state-db.ts",
    "src/state/openclaw-state.worker.ts",
    "src/state/openclaw-state-read.worker.ts",
    "src/state/openclaw-state-lease-worker.ts",
    "src/state/openclaw-state-lease-heartbeat.worker.ts",
    "src/infra/gateway-state-owner-heartbeat.worker.ts",
    "src/infra/sqlite-store.worker.ts",
    "src/infra/sqlite-readonly-location.worker.ts",
    "src/infra/worker-native-lifecycle.worker.ts",
  ]);
  expect(existsSync(join(root, "src/state/openclaw-state-worker-runtime.ts"))).toBe(false);
  const result = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { withWorktreeAllocationLease } from "./src/agents/worktrees/allocation.js";
        import {
          readTemplateAsync, reserveTemplateAsync,
        } from "./src/agents/worktrees/template-registry-async.js";
        import { withOpenClawStateLease } from "./src/state/openclaw-state-lease.js";
        import { closeOpenClawStateDatabaseAsync } from "./src/state/openclaw-state-db.js";
        const options = {
          scope: "core:wrapper-bootstrap",
          key: "lease",
          database: { scope: "shared", options: { env: process.env } },
          leaseMs: 60_000,
          waitMs: 0,
        };
        await withOpenClawStateLease(options, async (lease) => lease.assertOwned());
        await withWorktreeAllocationLease({ env: process.env }, async ({ commitGuard: guard }) => {
          const template = {
            cacheKey: "wrapper-template", id: "generation-1",
            repoRoot: process.cwd(), commonDir: process.cwd() + "/.git",
            worktreeRoot: process.cwd() + "/worktrees", path: process.cwd() + "/template",
            backend: "apfs", sourceCommit: "a".repeat(40), contentKey: "source",
            status: "preparing", createdAt: 1, lastUsedAt: 1,
          };
          await reserveTemplateAsync(process.env, template, guard);
          assert.deepEqual(await readTemplateAsync(process.env, template.cacheKey), template);
        });
        await closeOpenClawStateDatabaseAsync();
        console.log("LEASE_BOOTSTRAP_OK");
      `,
    ],
    {
      cwd: root,
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        OPENCLAW_STATE_DIR: join(root, "state"),
        TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
        NODE_OPTIONS: "",
        NODE_PATH: "",
      },
    },
  );
  expectResult(result, { status: 0, stdout: expect.stringContaining("LEASE_BOOTSTRAP_OK") });
});

it("resolves wrapper package exports and workspace aliases from the extracted dependency context", () => {
  const root = tempDirs.make("openclaw-pr-package-closure-");
  copyPrWrapperSources(root);
  const files = filesUnder(root).map((file) => relative(root, file));
  const pinned = run(process.execPath, [
    join(root, "scripts/pr-lib/materialize-dependencies.mjs"),
    join(process.cwd(), "node_modules"),
    join(root, "node_modules"),
  ]);
  expect(pinned.status, wrapperFailure(pinned.stderr)).toBe(0);
  const closure = collectRuntimeImportClosure(root, files, { validatePackages: true });
  expect(closure.filter((file) => file.startsWith("..") || !existsSync(join(root, file)))).toEqual(
    [],
  );
});

it.each([
  { source: 'import type { Missing } from "./missing.mts";', loadsModule: false },
  { source: 'import { type Missing } from "./missing.mts";', loadsModule: true },
  { source: 'export type { Missing } from "./missing.mts";', loadsModule: false },
  { source: 'export { type Missing } from "./missing.mts";', loadsModule: true },
])("matches plain Node's dependency requirement for $source", ({ source, loadsModule }) => {
  const root = tempDirs.make("openclaw-eager-import-closure-");
  const entry = join(root, "entry.mts");
  writeFileSync(entry, `${source}\nconsole.log("entry executed");\n`);
  const result = run(resolveTestNodeExecPath(), [entry], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  expect(result.status, result.stderr).toBe(loadsModule ? 1 : 0);
  const input = relative(process.cwd(), entry).replaceAll("\\", "/");
  if (loadsModule) {
    expect(result.stderr).toContain("Cannot find module");
    expect(() => collectRuntimeImportClosure(process.cwd(), [input])).toThrow(
      "unresolved ./missing.mts",
    );
  } else {
    expect(result.stdout.trim()).toBe("entry executed");
    expect(collectRuntimeImportClosure(process.cwd(), [input])).toEqual([input]);
  }
});

itPosix.each(["empty", "legacy", "outdated"])(
  "boots an anchor handed off by an older wrapper (dependencies=%s)",
  (dependencies) => {
    const { root, canonical, env: baseEnv, git } = wrapperFixture();
    const anchor = join(root, "anchor");
    mkdirSync(canonical);
    const env = {
      ...baseEnv,
      OPENCLAW_PR_ANCHOR_REPO_ROOT: canonical,
      TSX_TSCONFIG_PATH: join(anchor, "tsconfig.json"),
    };
    git(root, "init", canonical);
    copyPrWrapperSources(anchor);
    linkPrWrapperDependencies(canonical);
    if (dependencies === "legacy") {
      mkdirSync(join(anchor, "node_modules"));
      // The pre-#149585 parent only knew these four packages. Its code cannot be updated.
      for (const dependency of ["tsx", "zod", "minimatch", "yaml"]) {
        symlinkSync(
          realpathSync(join(canonical, "node_modules", dependency)),
          join(anchor, "node_modules", dependency),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
    }
    if (dependencies === "outdated") {
      replaceFsSafe(root, canonical, { version: "0.5.6" });
    }
    const bootstrap = run(join(anchor, "scripts/pr"), ["review-init"], { env });
    if (dependencies === "outdated") {
      expect(bootstrap.status, bootstrap.stderr).toBe(1);
      expect(bootstrap.stderr).toContain("has version 0.5.6; the trust anchor requires");
      expect(bootstrap.stderr).toContain(
        "The current trusted wrapper can materialize this anchor’s frozen dependencies",
      );
      expect(existsSync(join(anchor, "node_modules"))).toBe(false);
      expectResult(run("git", ["-C", canonical, "for-each-ref", "refs/openclaw"], { env }), {
        status: 0,
        stdout: "",
      });
      return;
    }
    expectResult(bootstrap, {
      status: 2,
      stdout: expect.stringContaining("scripts/pr review-init <PR>"),
    });
    if (dependencies === "legacy") {
      rmSync(join(canonical, "node_modules/yaml"));
      expectResult(run(join(anchor, "scripts/pr"), ["review-init"], { env }), {
        status: 2,
        stdout: expect.stringContaining("scripts/pr review-init <PR>"),
      });
    }
  },
);

itPosix.each([false, true])("launches a pre-helper anchor (manifest=%s)", (manifest) => {
  const { root, canonical, env, git } = wrapperFixture();
  const linked = join(root, "linked");
  Object.assign(env, {
    TMPDIR: root,
    GIT_AUTHOR_NAME: "OpenClaw Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "OpenClaw Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  });
  git(root, "init", "-b", "main", canonical);
  const wrapper = join(canonical, "scripts/pr");
  // The old entrypoint understands the verified handoff but has no dependency helper.
  writeFixture(canonical, {
    "scripts/pr":
      '#!/bin/bash\n# OPENCLAW_PR_ANCHOR_REPO_ROOT\nexec node "$(dirname "$0")/pr-lib/legacy-entry.mjs"\n',
    "scripts/pr-lib/legacy-entry.mjs": `import "${manifest ? "@openclaw/fs-safe/config" : "yaml"}";\nconsole.log("legacy anchor loaded");\n`,
    "scripts/pr-lib/wrapper-components.txt": `${manifest ? "package.json\n" : ""}scripts/pr-lib/legacy-entry.mjs\n`,
  });
  chmodSync(wrapper, 0o755);
  if (manifest) {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    packageJson.dependencies["@openclaw/fs-safe"] = "0.0.0-fixture";
    writeFixture(canonical, { "package.json": packageJson });
  }
  git(canonical, "add", ".");
  git(canonical, "commit", "-m", "test: pre-helper anchor");
  git(canonical, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(canonical, "worktree", "add", "-b", "caller", linked);
  copyFileSync("scripts/pr", join(linked, "scripts/pr"));
  copyFileSync(
    "scripts/pr-lib/materialize-dependencies.mjs",
    join(linked, "scripts/pr-lib/materialize-dependencies.mjs"),
  );
  git(linked, "add", "scripts");
  git(linked, "commit", "-m", "test: newer caller");
  git(canonical, "checkout", "-b", "parked");
  writeFileSync(wrapper, `${readFileSync(wrapper, "utf8")}# parked\n`);
  git(canonical, "commit", "-am", "test: park canonical wrapper");
  linkPrWrapperDependencies(canonical);
  if (manifest) {
    // The anchor's required version can differ from the newer parent's manifest.
    replaceFsSafe(root, canonical, {
      name: "@openclaw/fs-safe",
      version: "0.0.0-fixture",
      type: "module",
      exports: { "./config": "./config.js" },
    });
  }

  const result = run(join(linked, "scripts/pr"), ["review-init"], {
    cwd: linked,
    env,
  });
  expectResult(result, {
    status: 0,
    stderr: expect.stringContaining("running wrapper code materialized from"),
    stdout: "legacy anchor loaded\n",
  });
  expect(git(canonical, "for-each-ref", "refs/openclaw")).toBe("");
});

it("captures lazy platform modules and their runtime dependencies without loading them", () => {
  const directory = tempDirs.make("openclaw-runtime-import-closure-");
  writeFixture(directory, {
    "entry.mts": 'export const load = () => import("./platform.mts");',
    "platform.mts": 'import "./native.js"; throw new Error("must not load");',
    "native.ts": 'import type { Missing } from "./erased.ts";',
  });
  const entry = relative(process.cwd(), join(directory, "entry.mts")).replaceAll("\\", "/");
  expect(collectRuntimeImportClosure(process.cwd(), [entry])).toEqual([entry]);
  expect(
    collectRuntimeImportClosure(process.cwd(), [entry], { includeDynamicImports: true }),
  ).toEqual(
    ["entry.mts", "platform.mts", "native.ts"]
      .map((file) => relative(process.cwd(), join(directory, file)).replaceAll("\\", "/"))
      .toSorted(),
  );
});

it("resolves runtime aliases and import/require conditions without following declarations", () => {
  const root = tempDirs.make("openclaw-runtime-resolution-");
  writeFixture(root, {
    "tsconfig.json": {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        verbatimModuleSyntax: true,
        paths: { "@fixture/*": ["./src/*.ts"] },
      },
    },
    "package.json": {
      type: "module",
      imports: { "#branch": { import: "./import.ts", require: "./require.ts" } },
    },
    "entry.ts":
      'import "@fixture/alias"; import "./native.js"; import "./common.cts"; require("#branch");',
    "common.cts": 'export const load = () => import("#branch");',
    launch: "#!/bin/sh\nexit 0\n",
    "src/alias.ts": 'import type { Missing } from "./erased.js";',
    "native.js": 'import "./native-dependency.js";',
    "native.d.ts": 'export * from "./declaration-only.js";',
    "native-dependency.ts": "export const native = true;",
    "import.ts": "export const imported = true;",
    "require.ts": "export const required = true;",
  });

  expect(
    collectRuntimeImportClosure(root, ["entry.ts", "launch"], { includeDynamicImports: true }),
  ).toEqual([
    "common.cts",
    "entry.ts",
    "import.ts",
    "launch",
    "native-dependency.ts",
    "native.js",
    "require.ts",
    "src/alias.ts",
  ]);
  expect(collectRuntimeImportClosure(root, ["launch"])).toEqual(["launch"]);
  writeFileSync(join(root, "native.js"), 'import "./missing.js";');
  expect(() => collectRuntimeImportClosure(root, ["entry.ts"])).toThrow(
    "native.js: unresolved ./missing.js",
  );
});

const sessionMemoryOwners: string[] = [
  "src/config/sessions/session-actor-memory.ts",
  "src/config/sessions/session-actor-memory-owner.ts",
  "src/config/sessions/session-actor-storage-acquisition.ts",
];

it.each<[name: string, entrypoints: string[], deferredOwners: string[], dynamic?: boolean]>([
  [
    "native session worker transactions",
    [
      "src/config/sessions/session-actor.worker.ts",
      "src/config/sessions/session-turn.worker.ts",
      "src/config/sessions/goals-operations.worker.ts",
      "src/agents/sessions/session-manager-metadata.worker.ts",
      "src/agents/sessions/session-manager-maintenance.worker.ts",
      "src/gateway/worker-environments/transcript-commit.worker.ts",
    ],
    [
      ...sessionMemoryOwners,
      "src/config/sessions/goals-operations.ts",
      "src/agents/sessions/session-manager-reload.ts",
      "src/config/sessions/session-accessor.sqlite-transcript-write.ts",
      "src/config/io.runtime.ts",
    ],
  ],
  [
    "combined session store topology reads",
    ["src/config/sessions/combined-store-topology.worker.ts"],
    sessionMemoryOwners,
  ],
  [
    "session actor ownership reads",
    ["src/config/sessions/session-actor-storage-binding.ts"],
    sessionMemoryOwners,
    true,
  ],
  [
    "local avatar worker",
    ["src/agents/identity-avatar-file.worker.ts"],
    ["src/agents/agent-scope.ts", "src/agents/agent-scope-config.ts"],
  ],
  [
    "native update authority",
    [
      "src/cli/update-cli/update-command-executor.ts",
      "src/cli/update-cli/update-command-retained-service.ts",
      "src/cli/daemon-cli/update-executor.ts",
      "src/daemon/exec-file.ts",
    ],
    [
      "src/cli/update-cli/update-command-recovery.ts",
      "src/cli/update-cli/update-command-result.ts",
      "src/infra/update-managed-service-handoff.ts",
    ],
  ],
  [
    "migrated finalization",
    ["src/infra/update-migrated-finalize.worker.ts"],
    ["src/cli/daemon-cli.ts", "src/cli/daemon-cli/register.ts"],
  ],
  [
    "shared-state read worker startup",
    ["src/state/openclaw-state-read.worker.ts"],
    ["src/infra/state-migrations.cron-run-logs.ts", "src/cron/run-history-detail.ts"],
  ],
  [
    "shared-state read command handlers",
    ["src/state/openclaw-state-read-handlers.ts"],
    ["src/state/openclaw-agent-db.ts"],
  ],
  [
    "Git operation workers",
    ["src/infra/git-operation.worker.ts"],
    ["src/agents/worktrees/service-preparation.ts", "src/agents/worktrees/allocation.ts"],
    true,
  ],
  [
    "Git worktree inspections",
    ["src/agents/worktrees/git-worktree-operations.runtime.ts"],
    ["src/agents/worktrees/snapshot-inventory.ts"],
  ],
  [
    "persisted model catalog reader",
    ["src/agents/plugin-model-catalog-read.worker.ts"],
    ["src/state/openclaw-agent-db-readonly.ts", "src/state/openclaw-agent-db-borrower.ts"],
  ],
  [
    "canonical validation worker",
    [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts",
      "src/config/sessions/session-canonical-validation.ts",
    ],
    [
      "src/config/sessions/session-cold-storage-source-guard.worker.ts",
      "src/config/sessions/session-source-predicate.worker.ts",
    ],
  ],
  [
    "cold archive preparation",
    [
      "src/config/sessions/session-cold-storage-selection.ts",
      "src/config/sessions/session-cold-storage-prepare.ts",
    ],
    ["src/state/openclaw-agent-db.ts", "src/config/sessions/session-turn.kernel.ts"],
  ],
  [
    "transcript worker cold-error transport",
    [
      "src/config/sessions/session-transcript.worker.ts",
      "src/config/sessions/session-history-worker-errors.ts",
      "src/config/sessions/session-cold-storage-read.ts",
    ],
    ["src/config/sessions/session-cold-storage-state.ts", "src/infra/kysely-sync.ts"],
  ],
  [
    "Ollama config metadata",
    ["extensions/ollama/src/defaults.ts", "extensions/ollama/provider-policy-api.ts"],
    [
      "src/plugin-sdk/provider-model-shared.ts",
      "src/plugin-sdk/plugin-entry.ts",
      "src/plugins/provider-replay-helpers.ts",
    ],
  ],
])("keeps %s independent of deferred owners", (_name, entrypoints, deferredOwners, dynamic) => {
  const closure = collectRuntimeImportClosure(process.cwd(), entrypoints, {
    includeDynamicImports: dynamic ?? false,
  });
  expect(closure.filter((file) => deferredOwners.includes(file))).toEqual([]);
});
