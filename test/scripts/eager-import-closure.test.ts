import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  collectRuntimeImportClosure,
  createRuntimeImportGraph,
} from "../../scripts/lib/runtime-import-closure.mts";
import { ANCHOR_PREFIX } from "../../scripts/pr-lib/cache-lifetime.mjs";
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
  options: Pick<SpawnSyncOptions, "cwd" | "env" | "timeout" | "stdio" | "input"> = {},
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
  const root = realpathSync(tempDirs.make("openclaw-pr-anchor-"));
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

itPosix("refuses an env-only legacy handoff before running its materializer", () => {
  const { root, canonical, env, git } = wrapperFixture();
  const anchor = join(root, "anchor");
  const marker = join(root, "caller-materializer-ran");
  mkdirSync(canonical);
  git(root, "init", canonical);
  copyPrWrapperSources(anchor);
  writeFileSync(
    join(anchor, "scripts/pr-lib/materialize-dependencies.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
  );
  const result = run(join(anchor, "scripts/pr"), ["review-init"], {
    env: { ...env, OPENCLAW_PR_ANCHOR_REPO_ROOT: canonical },
  });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("Legacy PR anchor cannot acquire versioned lifetime holds");
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(anchor, "node_modules"))).toBe(false);
  expect(git(canonical, "for-each-ref", "refs/openclaw")).toBe("");
});

itPosix.each(["empty", "legacy", "outdated"])(
  "materializes an owned anchor with %s dependencies",
  (dependencies) => {
    const { root, canonical, env: baseEnv, git } = wrapperFixture();
    const anchor = mkdtempSync(join(root, `${ANCHOR_PREFIX}${process.pid}.`));
    mkdirSync(canonical);
    git(root, "init", canonical);
    copyPrWrapperSources(anchor);
    linkPrWrapperDependencies(canonical);
    const legacyPins = new Map<string, string>();
    if (dependencies === "legacy") {
      mkdirSync(join(anchor, "node_modules"));
      for (const dependency of ["tsx", "zod", "minimatch", "yaml"]) {
        const target = realpathSync(join(canonical, "node_modules", dependency));
        legacyPins.set(dependency, target);
        symlinkSync(target, join(anchor, "node_modules", dependency), "dir");
      }
    }
    if (dependencies === "outdated") {
      replaceFsSafe(root, canonical, { version: "0.5.6" });
    }
    const descriptor = openSync(anchor, "r");
    try {
      const materialize = () =>
        run(
          resolveTestNodeExecPath(),
          [
            "--input-type=module",
            "-e",
            `
              import { claimCreatedAnchor } from ${JSON.stringify(pathToFileURL(join(anchor, "scripts/pr-lib/cache-lifetime.mjs")).href)};
              import { pathToFileURL } from "node:url";
              claimCreatedAnchor(process.argv[1], process.ppid);
              process.argv = [process.execPath, process.argv[2], process.argv[3], process.argv[4]];
              await import(pathToFileURL(process.argv[1]).href);
            `,
            anchor,
            join(anchor, "scripts/pr-lib/materialize-dependencies.mjs"),
            join(canonical, "node_modules"),
            join(anchor, "node_modules"),
          ],
          {
            env: {
              ...baseEnv,
              OPENCLAW_PR_ANCHOR_CREATOR_PID: String(process.pid),
              OPENCLAW_PR_ANCHOR_FD: "9",
            },
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
              descriptor,
            ],
          },
        );
      const result = materialize();
      if (dependencies === "outdated") {
        expect(result.status, result.stderr).toBe(78);
        expect(result.stderr).toContain("has version 0.5.6; the trust anchor requires");
        expect(result.stderr).toContain(
          "The current trusted wrapper can materialize this anchor’s frozen dependencies",
        );
        expect(existsSync(join(anchor, "node_modules"))).toBe(false);
        expect(git(canonical, "for-each-ref", "refs/openclaw")).toBe("");
        return;
      }
      expectResult(result, { status: 0 });
      expect(realpathSync(join(anchor, "node_modules/@openclaw/fs-safe"))).toBe(
        realpathSync(join(canonical, "node_modules/@openclaw/fs-safe")),
      );
      if (dependencies === "legacy") {
        const yamlManifest = readFileSync(join(legacyPins.get("yaml")!, "package.json"), "utf8");
        rmSync(join(canonical, "node_modules/yaml"));
        expectResult(materialize(), { status: 0 });
        for (const [dependency, target] of legacyPins) {
          expect(realpathSync(join(anchor, "node_modules", dependency))).toBe(target);
        }
        expect(readFileSync(join(anchor, "node_modules/yaml/package.json"), "utf8")).toBe(
          yamlManifest,
        );
      }
    } finally {
      closeSync(descriptor);
    }
  },
);

itPosix.each([
  { manifest: false, bootstrap: true },
  { manifest: true, bootstrap: true },
  { manifest: false, bootstrap: false },
])(
  "launches a pre-helper anchor (manifest=$manifest, bootstrap=$bootstrap)",
  ({ manifest, bootstrap }) => {
    const { root, canonical, env, git } = wrapperFixture();
    const linked = join(root, "linked");
    const origin = join(root, "origin.git");
    const marker = join(root, "caller-materializer-ran");
    Object.assign(env, {
      TMPDIR: root,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    });
    git(root, "init", "--bare", "-b", "main", origin);
    git(root, "init", "-b", "main", canonical);
    git(canonical, "remote", "add", "origin", origin);
    const wrapper = join(canonical, "scripts/pr");
    // Workflow policy is historical; bootstrap authority comes from the later main commit.
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
    const selected = git(canonical, "rev-parse", "HEAD");
    copyPrWrapperSources(canonical);
    if (!bootstrap) {
      rmSync(join(canonical, "scripts/pr-lib/cache-lifetime.mjs"));
    }
    git(canonical, "add", ".");
    git(canonical, "commit", "-m", "test: current bootstrap authority");
    git(canonical, "push", "-u", "origin", "main");
    const producer = readFileSync("scripts/pr", "utf8")
      .split("<<'EOF_WRAPPER_GIT'\n")[1]!
      .split("\nEOF_WRAPPER_GIT")[0]!;
    const admitted = run(
      resolveTestNodeExecPath(),
      [
        "--input-type=module",
        "-",
        "git",
        "workflow-admit",
        canonical,
        "123",
        selected,
        "",
        "refs/remotes/origin/main",
      ],
      { input: producer, env },
    );
    expectResult(admitted, { status: 0 });
    const binding = admitted.stdout.trim();
    const bindingRef = "refs/openclaw/pr-workflow-bindings/123";
    expect(git(canonical, "rev-parse", bindingRef)).toBe(binding);
    expect(JSON.parse(git(canonical, "show", `${binding}:binding.json`)).source).toBe(selected);
    git(canonical, "worktree", "add", "-b", "caller", linked);
    writeFileSync(
      join(linked, "scripts/pr-lib/materialize-dependencies.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
    );
    git(linked, "add", "scripts");
    git(linked, "commit", "-m", "test: rejected caller helper");
    git(canonical, "checkout", "-b", "parked");
    writeFileSync(wrapper, `${readFileSync(wrapper, "utf8")}# parked\n`);
    git(canonical, "commit", "-am", "test: park canonical wrapper");
    linkPrWrapperDependencies(canonical);
    if (manifest) {
      replaceFsSafe(root, canonical, {
        name: "@openclaw/fs-safe",
        version: "0.0.0-fixture",
        type: "module",
        exports: { "./config": "./config.js" },
      });
    }
    const result = run(join(linked, "scripts/pr"), ["review-init", "123"], { cwd: linked, env });
    if (bootstrap) {
      expectResult(result, {
        status: 0,
        stderr: expect.stringContaining("running wrapper code materialized from"),
        stdout: "legacy anchor loaded\n",
      });
    } else {
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Bootstrap closure unavailable");
      expect(result.stdout).not.toContain("legacy anchor loaded");
    }
    expect(existsSync(marker)).toBe(false);
    expect(git(canonical, "rev-parse", bindingRef)).toBe(binding);
    expect(JSON.parse(git(canonical, "show", `${binding}:binding.json`)).source).toBe(selected);
  },
);

it("retains declaration-only inventories without executing their imports", () => {
  const root = tempDirs.make("openclaw-declaration-inventory-");
  const files = ["entry.d.ts", "entry.d.mts", "entry.d.cts"];
  writeFixture(
    root,
    Object.fromEntries(files.map((file) => [file, 'export * from "./missing.js";'])),
  );
  expect(collectRuntimeImportClosure(root, files)).toEqual(files.toSorted());
});

it("traverses runtime sources in mixed inventories and still rejects missing runtime imports", () => {
  const root = tempDirs.make("openclaw-mixed-inventory-");
  writeFixture(root, {
    "tsconfig.json": { compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } },
    "entry.mts": 'import "./dependency.mjs";',
    "dependency.mts": "export {};",
    "entry.d.mts": 'export * from "./declaration-only.mjs";',
  });
  expect(collectRuntimeImportClosure(root, ["entry.mts", "entry.d.mts"])).toEqual([
    "dependency.mts",
    "entry.d.mts",
    "entry.mts",
  ]);
  using graph = createRuntimeImportGraph(root, ["entry.mts", "entry.d.mts"]);
  expect(graph.dependencies("entry.d.mts")).toEqual([]);
  writeFileSync(join(root, "dependency.mts"), 'import "./missing.mjs";');
  expect(() => collectRuntimeImportClosure(root, ["entry.mts", "entry.d.mts"])).toThrow(
    "dependency.mts: unresolved ./missing.mjs",
  );
});

it("preserves declaration resolution for source-import graphs", () => {
  const root = tempDirs.make("openclaw-source-declarations-");
  writeFixture(root, {
    "tsconfig.json": { compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } },
    "entry.mts": 'import type { Value } from "./types.mjs";',
    "types.d.mts": "export type Value = string;",
  });
  using graph = createRuntimeImportGraph(root, ["entry.mts", "types.d.mts"], {
    sourceImports: true,
    includeTypeOnlyImports: true,
  });
  expect(graph.dependencies("entry.mts")).toMatchObject([
    { specifier: "./types.mjs", resolvedFileName: join(root, "types.d.mts") },
  ]);
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
