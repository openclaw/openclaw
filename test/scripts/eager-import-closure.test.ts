import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
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

it("keeps the PR wrapper inventory closed over runtime imports", () => {
  const components = readFileSync(wrapperInventory, "utf8").trim().split("\n");
  const stale = components.filter((file) => !existsSync(file)).toSorted();
  // scripts/pr archives all of pr-lib implicitly. Other inventory entries also
  // seed the graph: shell-launched helpers and workers are not ordinary imports.
  const wrapperFiles = readdirSync("scripts/pr-lib", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const closure = collectRuntimeImportClosure(process.cwd(), [
    ...wrapperFiles,
    ...components.filter((file) => existsSync(file)),
  ]);
  const extracted = new Set(["scripts/pr", ...components]);
  const missing = closure.filter(
    (file) => !file.startsWith("scripts/pr-lib/") && !extracted.has(file),
  );
  const diagnostic = [
    "The trusted-anchor PR wrapper extracts only scripts/pr, scripts/pr-lib, and its inventory.",
    ...(missing.length
      ? [
          `Missing runtime imports:\n${missing.join("\n")}`,
          `Add these lines to ${wrapperInventory}.`,
        ]
      : []),
    // Existing non-imported assets may be loaded by path; only deleted paths
    // are provably stale without changing the extraction contract.
    ...(stale.length
      ? [
          `Stale paths (absent from the repository):\n${stale.join("\n")}`,
          `Remove these lines from ${wrapperInventory}.`,
        ]
      : []),
    `Run locally: ${inventoryCheck}`,
  ].join("\n");
  expect({ missing, stale }, diagnostic).toEqual({ missing: [], stale: [] });
});

it("acquires and releases wrapper leases without the application command runtime", async () => {
  const root = tempDirs.make("openclaw-pr-lease-bootstrap-");
  copyPrWrapperSources(root);
  linkPrWrapperDependencies(root);
  await prepareCopiedSourceModules(root, [
    "src/state/openclaw-state-lease.ts",
    "src/state/openclaw-state-db.ts",
    "src/state/openclaw-state.worker.ts",
    "src/state/openclaw-state-lease-worker.ts",
    "src/state/openclaw-state-lease-heartbeat.worker.ts",
    "src/infra/sqlite-store.worker.ts",
    "src/infra/sqlite-readonly-location.worker.ts",
  ]);
  expect(existsSync(join(root, "src/state/openclaw-state-worker-runtime.ts"))).toBe(false);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { withOpenClawStateLease } from "./src/state/openclaw-state-lease.js";
        import {
          closeOpenClawStateDatabaseAsync,
          openOpenClawStateDatabase,
        } from "./src/state/openclaw-state-db.js";
        const options = {
          scope: "core:wrapper-bootstrap",
          key: "lease",
          database: { scope: "shared", options: { env: process.env } },
          leaseMs: 60_000,
          waitMs: 0,
        };
        for (let grant = 0; grant < 2; grant += 1) {
          await withOpenClawStateLease(options, async (lease) => lease.assertOwned());
        }
        const database = openOpenClawStateDatabase({ env: process.env });
        const row = database.db.prepare(
          "SELECT COUNT(*) AS count FROM state_leases WHERE scope = ? AND lease_key = ?",
        ).get(options.scope, options.key);
        assert.equal(Number(row.count), 0);
        await closeOpenClawStateDatabaseAsync();
        console.log("LEASE_BOOTSTRAP_OK");
      `,
    ],
    {
      cwd: root,
      encoding: "utf8",
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
  expect(result.status, wrapperFailure(result.stderr)).toBe(0);
  expect(result.stdout, wrapperFailure(result.stderr)).toContain("LEASE_BOOTSTRAP_OK");
});

it("resolves wrapper package exports and workspace aliases from the extracted dependency context", () => {
  const root = tempDirs.make("openclaw-pr-package-closure-");
  const components = copyPrWrapperSources(root);
  expect(components.filter((component, index) => components.indexOf(component) !== index)).toEqual(
    [],
  );
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
  for (const entrypoint of [
    "src/state/openclaw-state.worker.ts",
    "src/state/openclaw-state-lease-worker.ts",
    "src/infra/sqlite-store.worker.ts",
  ]) {
    expect(files).toContain(join(entrypoint));
  }
  const pinned = spawnSync(
    process.execPath,
    [
      join(root, "scripts/pr-lib/materialize-dependencies.mjs"),
      join(process.cwd(), "node_modules"),
      join(root, "node_modules"),
    ],
    { encoding: "utf8" },
  );
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
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    encoding: "utf8",
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
    const root = tempDirs.make("openclaw-pr-anchor-dependencies-");
    const canonical = join(root, "canonical");
    const anchor = join(root, "anchor");
    mkdirSync(canonical);
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      OPENCLAW_PR_ANCHOR_REPO_ROOT: canonical,
      TSX_TSCONFIG_PATH: join(anchor, "tsconfig.json"),
    };
    const initialized = spawnSync("git", ["init", canonical], { env, encoding: "utf8" });
    expect(initialized.status, initialized.stderr).toBe(0);
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
      const obsoletePackage = join(root, "obsolete-fs-safe");
      mkdirSync(obsoletePackage);
      writeFileSync(join(obsoletePackage, "package.json"), JSON.stringify({ version: "0.5.6" }));
      const donor = join(canonical, "node_modules/@openclaw/fs-safe");
      rmSync(donor);
      symlinkSync(obsoletePackage, donor, process.platform === "win32" ? "junction" : "dir");
    }
    const bootstrap = spawnSync(join(anchor, "scripts/pr"), ["review-init"], {
      env,
      encoding: "utf8",
    });
    if (dependencies === "outdated") {
      expect(bootstrap.status, bootstrap.stderr).toBe(1);
      expect(bootstrap.stderr).toContain("has version 0.5.6; the trust anchor requires");
      expect(bootstrap.stderr).toContain(
        "Restore frozen dependencies in a clean trusted-main checkout",
      );
      expect(existsSync(join(anchor, "node_modules"))).toBe(false);
      const locks = spawnSync("git", ["-C", canonical, "for-each-ref", "refs/openclaw"], {
        env,
        encoding: "utf8",
      });
      expect(locks.status, locks.stderr).toBe(0);
      expect(locks.stdout).toBe("");
      return;
    }
    expect(bootstrap.status, wrapperFailure(bootstrap.stderr)).toBe(2);
    expect(bootstrap.stdout, wrapperFailure(bootstrap.stderr)).toContain(
      "scripts/pr review-init <PR>",
    );
    const provision = spawnSync(
      process.execPath,
      [
        "--import",
        join(anchor, "scripts/tsx.mjs"),
        join(anchor, "scripts/pr-lib/worktree-provision.mts"),
      ],
      { env, encoding: "utf8" },
    );
    expect(provision.status, wrapperFailure(provision.stderr)).toBe(1);
    expect(provision.stderr, wrapperFailure(provision.stderr)).toContain(
      "Usage: worktree-provision.mts",
    );

    if (dependencies !== "legacy") {
      return;
    }
    rmSync(join(canonical, "node_modules/yaml"));
    const supervised = spawnSync(join(anchor, "scripts/pr"), ["review-init"], {
      env,
      encoding: "utf8",
    });
    expect(supervised.status, wrapperFailure(supervised.stderr)).toBe(2);
    expect(supervised.stdout, wrapperFailure(supervised.stderr)).toContain(
      "scripts/pr review-init <PR>",
    );
  },
);

itPosix.each([false, true])("launches a pre-helper anchor (manifest=%s)", (manifest) => {
  const root = tempDirs.make("openclaw-pr-legacy-anchor-");
  const canonical = join(root, "canonical");
  const linked = join(root, "linked");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "OpenClaw Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "OpenClaw Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git(root, "init", "-b", "main", canonical);
  mkdirSync(join(canonical, "scripts/pr-lib"), { recursive: true });
  const wrapper = join(canonical, "scripts/pr");
  // The old entrypoint understands the verified handoff but has no dependency helper.
  writeFileSync(
    wrapper,
    '#!/bin/bash\n# OPENCLAW_PR_ANCHOR_REPO_ROOT\nexec node "$(dirname "$0")/pr-lib/legacy-entry.mjs"\n',
  );
  chmodSync(wrapper, 0o755);
  writeFileSync(
    join(canonical, "scripts/pr-lib/legacy-entry.mjs"),
    `import "${manifest ? "@openclaw/fs-safe/config" : "yaml"}";\nconsole.log("legacy anchor loaded");\n`,
  );
  writeFileSync(
    join(canonical, "scripts/pr-lib/wrapper-components.txt"),
    `${manifest ? "package.json\n" : ""}scripts/pr-lib/legacy-entry.mjs\n`,
  );
  if (manifest) {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    packageJson.dependencies["@openclaw/fs-safe"] = "0.0.0-fixture";
    writeFileSync(join(canonical, "package.json"), JSON.stringify(packageJson));
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
    const dependency = join(root, "older-fs-safe");
    mkdirSync(dependency);
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "@openclaw/fs-safe",
        version: "0.0.0-fixture",
        type: "module",
        exports: { "./config": "./config.js" },
      }),
    );
    writeFileSync(join(dependency, "config.js"), "export {};\n");
    const installed = join(canonical, "node_modules/@openclaw/fs-safe");
    rmSync(installed);
    symlinkSync(dependency, installed, "dir");
  }

  const result = spawnSync(join(linked, "scripts/pr"), ["review-init"], {
    cwd: linked,
    env,
    encoding: "utf8",
  });
  expect(result.status, wrapperFailure(result.stderr)).toBe(0);
  expect(result.stderr, wrapperFailure(result.stderr)).toContain(
    "running wrapper code materialized from",
  );
  expect(result.stdout, wrapperFailure(result.stderr)).toBe("legacy anchor loaded\n");
  expect(git(canonical, "for-each-ref", "refs/openclaw")).toBe("");
});

it("captures lazy platform modules and their runtime dependencies without loading them", () => {
  const directory = tempDirs.make("openclaw-runtime-import-closure-");
  writeFileSync(
    join(directory, "entry.mts"),
    'export const load = () => import("./platform.mts");',
  );
  writeFileSync(
    join(directory, "platform.mts"),
    'import "./native.js"; throw new Error("must not load");',
  );
  writeFileSync(join(directory, "native.ts"), 'import type { Missing } from "./erased.ts";');
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
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        verbatimModuleSyntax: true,
        paths: { "@fixture/*": ["./src/*.ts"] },
      },
    }),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      imports: { "#branch": { import: "./import.ts", require: "./require.ts" } },
    }),
  );
  for (const [file, source] of Object.entries({
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
  })) {
    writeFileSync(join(root, file), source);
  }

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

it("keeps native update authority free of eager recovery reporting and handoff staging", () => {
  const closure = collectRuntimeImportClosure(process.cwd(), [
    "src/cli/update-cli/update-command-executor.ts",
    "src/cli/update-cli/update-command-retained-service.ts",
    "src/cli/daemon-cli/update-executor.ts",
    "src/daemon/exec-file.ts",
  ]);
  const deferredOwners = new Set([
    "src/cli/update-cli/update-command-recovery.ts",
    "src/cli/update-cli/update-command-result.ts",
    "src/infra/update-managed-service-handoff.ts",
  ]);
  expect(closure.filter((file) => deferredOwners.has(file))).toEqual([]);
});

it("keeps migrated finalization free of eager CLI registration", () => {
  const closure = collectRuntimeImportClosure(process.cwd(), [
    "src/infra/update-migrated-finalize.worker.ts",
  ]);
  const validationOnly = new Set(["src/cli/daemon-cli.ts", "src/cli/daemon-cli/register.ts"]);
  expect(closure.filter((file) => validationOnly.has(file))).toEqual([]);
});
