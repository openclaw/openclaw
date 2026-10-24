import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  applyLocalOxlintPolicy,
  applyLocalTsgoPolicy,
  ensureRepoNodeModulesLink,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
  resolveTypeCheckTool,
} from "../../scripts/lib/local-check-runtime.mts";
import { resolveTsxImport } from "../../scripts/lib/tsx-cli-shim.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
function writeFiles(root: string, files: Record<string, string>) {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}
const GIB = 1024 ** 3;
const ROOMY_HOST = { totalMemoryBytes: 128 * GIB, logicalCpuCount: 16 };
const throttledGoEnv = { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" };
const noGoEnv = { GOMAXPROCS: undefined, GOGC: undefined, GOMEMLIMIT: undefined };
type CheckResources = Parameters<typeof applyLocalTsgoPolicy>[2];
function makeEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    OPENCLAW_LOCAL_CHECK: "1",
    OPENCLAW_LOCAL_CHECK_MODE: undefined,
    GITHUB_ACTIONS: undefined,
    ...overrides,
  };
}

it("keeps tsgo type checking on hosts without a tsrs binary", () => {
  expect(resolveTypeCheckTool("linux", "x64", {})).toBe("tsrs");
  expect(resolveTypeCheckTool("win32", "x64", {})).toBe("tsgo");
});

it("lets OPENCLAW_TYPECHECKER force the tsgo fallback", () => {
  expect(resolveTypeCheckTool("linux", "x64", { OPENCLAW_TYPECHECKER: "tsgo" })).toBe("tsgo");
  expect(resolveTypeCheckTool("linux", "x64", { OPENCLAW_TYPECHECKER: " tsrs " })).toBe("tsrs");
  expect(() => resolveTypeCheckTool("win32", "x64", { OPENCLAW_TYPECHECKER: "tsrs" })).toThrow(
    /no binary for win32-x64/,
  );
  expect(() => resolveTypeCheckTool("linux", "x64", { OPENCLAW_TYPECHECKER: "tsc" })).toThrow(
    /must be tsrs or tsgo/,
  );
});

it("uses Go profiling without silently ignoring an explicit tsrs request", () => {
  expect(resolveTypeCheckTool("linux", "x64", {}, ["--pprofDir=profiles"])).toBe("tsgo");
  expect(() =>
    resolveTypeCheckTool("linux", "x64", { OPENCLAW_TYPECHECKER: "tsrs" }, ["--pprofDir=profiles"]),
  ).toThrow(/tsrs does not support --pprofDir/);
});

it("resolves repo tools from the primary checkout for dependency-less worktrees", () => {
  const primaryRoot = createTempDir("openclaw-primary-checkout-");
  const cwd = path.join(primaryRoot, ".codex", "worktrees", "task", "openclaw");
  const localPath = path.resolve(cwd, "node_modules", ".bin", "oxlint");
  const primaryPath = path.join(primaryRoot, "node_modules", ".bin", "oxlint");

  const resolve = (installed: string[]) =>
    resolveRepoToolBinPath("oxlint", {
      cwd,
      fileExists: (candidate) => installed.includes(candidate),
      resolveCommonDir: () => path.join(primaryRoot, ".git"),
    });
  expect(resolve([primaryPath])).toBe(primaryPath);
  expect(resolve([localPath, primaryPath])).toBe(localPath);
});

it("creates a Windows junction once for declaration dependencies", () => {
  const cwd = createTempDir("openclaw-primary-toolchain-");
  const primaryNodeModules = path.join(cwd, "installed");
  const localNodeModules = path.join(cwd, "node_modules");
  fs.mkdirSync(primaryNodeModules);
  const linkTypes: Array<Parameters<typeof fs.symlinkSync>[2]> = [];
  const linkOptions = {
    cwd,
    platform: "win32" as const,
    symlink: (...args: Parameters<typeof fs.symlinkSync>) => {
      linkTypes.push(args[2]);
      fs.symlinkSync(...args);
    },
  };
  expect(ensureRepoNodeModulesLink(primaryNodeModules, linkOptions)).toBe(localNodeModules);
  expect(fs.realpathSync(localNodeModules)).toBe(fs.realpathSync(primaryNodeModules));
  expect(ensureRepoNodeModulesLink(primaryNodeModules, linkOptions)).toBe(localNodeModules);
  expect(linkTypes).toEqual(["junction"]);
});
it.each([
  { env: { PATH: "/usr/bin" }, disabled: ["0", "false"], enabled: "1" },
  { env: { CI: "true", PATH: "/usr/bin" }, disabled: ["0"], enabled: "0" },
])("resolves wrapper policy for $env", ({ env, disabled, enabled }) => {
  for (const value of disabled) {
    expect(resolveLocalCheckEnv({ ...env, OPENCLAW_LOCAL_CHECK: value })).toEqual({
      ...env,
      OPENCLAW_LOCAL_CHECK: enabled,
    });
  }
});

it("applies tsgo profiling without a throttled mode", () => {
  const args: readonly string[] = ["-p", "tsconfig.ui.json"];
  const profiles = ".artifacts/profiles";
  const result = applyLocalTsgoPolicy([...args], { OPENCLAW_TSGO_PPROF_DIR: profiles }, ROOMY_HOST);
  expect(result.args).toEqual([...args, "--declaration", "false", "--pprofDir", profiles]);
  for (const key of ["OPENCLAW_LOCAL_CHECK_MODE", "GOMAXPROCS", "GOMEMLIMIT"]) {
    expect(result.env[key], key).toBeUndefined();
  }
});

it("applies tsgo policy for a single CPU", () => {
  const env = makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "throttled" });
  const result = applyLocalTsgoPolicy([], env, { logicalCpuCount: 1, totalMemoryBytes: 16 * GIB });
  expect(result.env.GOMAXPROCS).toBe("1");
});

it("sizes compiler workers from unresolved capacity instead of remaining memory", () => {
  const host = {
    logicalCpuCount: 16,
    totalMemoryBytes: 64 * GIB,
    memoryCapacityBytes: null,
    memoryLimitBytes: GIB,
  };
  for (const ci of [undefined, "true"]) {
    const inputEnv = makeEnv({
      CI: ci,
      OPENCLAW_LOCAL_CHECK: ci ? "0" : "1",
      ...noGoEnv,
    });
    for (const [result, flag] of [
      [applyLocalTsgoPolicy(["--noEmit"], inputEnv, host), "--singleThreaded"],
      [applyLocalOxlintPolicy([], inputEnv, host), "--threads=1"],
    ] as const) {
      expect(result.args).toContain(flag);
      expect(result.env).toMatchObject({ GOMEMLIMIT: "3GiB", GOMAXPROCS: "2" });
    }
  }
});

const extensions = ["--tsconfig", "extensions/tsconfig.json"];
function bounded(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  resources: Partial<CheckResources> = {},
) {
  const inputEnv: NodeJS.ProcessEnv = makeEnv({
    CI: "true",
    OPENCLAW_LOCAL_CHECK: "0",
    OPENCLAW_OXLINT_BATCH_CONCURRENCY: "1",
    OPENCLAW_OXLINT_BOUNDED_SHARD_ARGS: JSON.stringify(args),
    ...noGoEnv,
    ...env,
  });
  const result = applyLocalOxlintPolicy(args, inputEnv, {
    logicalCpuCount: 4,
    totalMemoryBytes: 16 * GIB,
    memoryCapacityBytes: 16 * GIB,
    memoryLimitBytes: 16 * GIB,
    platform: "linux",
    ...resources,
  });
  return { ...result, inputEnv };
}

it("applies the bounded CI budget for admitted extensions/tsconfig.json", () => {
  const result = bounded(
    extensions,
    {},
    { memoryCapacityBytes: 15 * GIB, memoryLimitBytes: 14 * GIB },
  );
  expect(result.env).toMatchObject({ GOMAXPROCS: "4", GOGC: "100", GOMEMLIMIT: "8GiB" });
  expect(result.args).toEqual(expect.arrayContaining(["--threads=2", "--type-aware"]));
  expect(result.inputEnv.GOMEMLIMIT).toBeUndefined();
});

it("applies explicit limits and throttles unmeasured configurations", () => {
  const env = { GOMAXPROCS: "1", GOGC: "20", GOMEMLIMIT: "2GiB" };
  const result = bounded([...extensions, "--threads=1"], env);
  expect(result.env).toMatchObject(env);
  expect(result.args).toContain("--threads=1");
  for (const args of [
    ["--tsconfig", "test/tsconfig/tsconfig.test.root.json"],
    [...extensions, "--threads=4"],
    [...extensions, "--", "--threads=4"],
  ]) {
    expect(bounded(args).env).toMatchObject(throttledGoEnv);
  }
});

it("throttles bounded CI admission with unknown available memory", () => {
  const result = bounded([...extensions, "extensions/example"], {}, { memoryLimitBytes: null });
  expect(result.env).toMatchObject(throttledGoEnv);
  expect(result.args).toContain("--threads=1");
});

it("keeps prep and oxlint resource policies separate", () => {
  const cwd = createTempDir("openclaw-oxlint-go-limit-");
  // Keep artifact ownership inside this fixture when its temp directory has a checkout ancestor.
  fs.mkdirSync(path.join(cwd, ".git"));
  const capturePath = path.join(cwd, "children.jsonl");
  const oxlintPath = path.join(cwd, "node_modules", ".bin", "oxlint");
  const captureSource = `
const goEnv = Object.fromEntries(["GOMAXPROCS", "GOGC", "GOMEMLIMIT"].map(key => [key, process.env[key] ?? null]));
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify([step, ...Object.values(goEnv), process.argv.slice(2)]) + "\\n");
`;
  writeFiles(cwd, {
    "scripts/prepare-extension-package-boundary-artifacts.mts": `import fs from "node:fs";\nconst step = "prep";\n${captureSource}`,
    "node_modules/.bin/oxlint": `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst step = "lint";\n${captureSource}`,
  });
  fs.chmodSync(oxlintPath, 0o755);
  const env = makeEnv({
    CAPTURE_PATH: capturePath,
    OPENCLAW_OXLINT_SKIP_PREPARE: undefined,
    ...noGoEnv,
  });

  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/run-oxlint.mjs"), "--tsconfig", "extensions/tsconfig.json"],
    { cwd, encoding: "utf8", env },
  );

  expect(result.status, result.stderr).toBe(0);
  const children = fs
    .readFileSync(capturePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(children).toEqual([
    ["prep", null, null, null, ["--mode=package-boundary"]],
    [
      "lint",
      String(Math.min(2, Math.max(1, os.availableParallelism()))),
      "30",
      "3GiB",
      [
        ...extensions,
        "--type-aware",
        "--report-unused-disable-directives-severity",
        "error",
        "--threads=1",
      ],
    ],
  ]);
});

it.each([undefined, "-fjson"])(
  "keeps GitHub Actions output formatting explicit (%s)",
  (formatArg) => {
    const { args } = applyLocalOxlintPolicy(
      formatArg ? [formatArg] : ["--", "src/example.ts"],
      makeEnv({ GITHUB_ACTIONS: "true", OPENCLAW_LOCAL_CHECK_MODE: "full" }),
      ROOMY_HOST,
    );
    if (formatArg) {
      expect(args).not.toContain("stylish");
    } else {
      expect(args.slice(-4)).toEqual(["--format", "stylish", "--", "src/example.ts"]);
    }
  },
);
afterEach(() => vi.unstubAllEnvs());

function fixture(native = false) {
  for (const key of [
    "PNPM_CONFIG_MODULES_DIR",
    "pnpm_config_modules_dir",
    "npm_config_modules_dir",
  ]) {
    vi.stubEnv(key, undefined);
  }
  const root = fs.realpathSync(createTempDir("openclaw-toolchain-ownership-"));
  const checkout = path.join(root, "checkout");
  const configured = " modules";
  const modules = path.join(root, native ? "checkout/ modules" : "primary/node_modules");
  const name = native ? "fixture-dependency" : "tsx";
  const dependency = path.join(modules, name);
  fs.mkdirSync(checkout);
  const exports = native ? "./index.js" : { "./esm": "./esm.mjs" };
  writeFiles(dependency, {
    "package.json": JSON.stringify({ name, type: "module", exports }),
    [native ? "index.js" : "esm.mjs"]: native ? 'export default "configured";\n' : "export {};\n",
  });
  if (native) {
    const lib = path.join(checkout, "scripts", "lib");
    fs.mkdirSync(lib, { recursive: true });
    for (const file of [
      "tsx-cli-shim.mjs",
      "local-check-runtime.mts",
      "managed-cleanup-handoff.mts",
    ]) {
      fs.copyFileSync(path.resolve("scripts", "lib", file), path.join(lib, file));
    }
    writeFiles(checkout, {
      "scripts/entry.mjs":
        'import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs"; await runNodeCliShim(import.meta.url, { implementation: "./implementation.mts" });\n',
      "scripts/implementation.mts": 'import value from "fixture-dependency"; console.log(value);\n',
    });
  }
  const run = (overrides: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [path.join(checkout, "scripts/entry.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PNPM_CONFIG_MODULES_DIR: undefined,
        pnpm_config_modules_dir: undefined,
        npm_config_modules_dir: undefined,
        ...overrides,
      },
    });
  const entry = pathToFileURL(path.join(dependency, "esm.mjs")).href;
  return { checkout, modules, configured, run, entry };
}

it.each(["configured", "directory", "link", "empty alias", "npm fallback"])(
  "loads native child packages with %s dependency ownership",
  (kind) => {
    const { checkout, modules, configured, run } = fixture(true);
    const local = path.join(checkout, "node_modules");
    const ownedCheckout = kind === "directory" || kind === "link";
    if (ownedCheckout) {
      const owned = kind === "directory" ? local : path.join(checkout, "owned");
      fs.cpSync(modules, owned, { recursive: true });
      writeFiles(owned, { "fixture-dependency/index.js": 'export default "owned";\n' });
      if (kind === "link") {
        fs.symlinkSync(owned, local, process.platform === "win32" ? "junction" : "dir");
      }
    }
    const before = fs.lstatSync(ownedCheckout ? local : modules);
    const emptyAlias = kind === "empty alias" || kind === "npm fallback";
    const result = run(
      emptyAlias
        ? {
            PNPM_CONFIG_MODULES_DIR: "",
            pnpm_config_modules_dir: configured,
            npm_config_modules_dir: kind === "npm fallback" ? configured : undefined,
          }
        : { PNPM_CONFIG_MODULES_DIR: configured },
    );
    expect(result.status, result.stderr).toBe(kind === "empty alias" ? 1 : 0);
    if (kind === "empty alias") {
      expect(result.stderr).toContain("Cannot find package 'fixture-dependency'");
      expect(fs.existsSync(local)).toBe(false);
    } else {
      expect(result.stdout.trim()).toBe(ownedCheckout ? "owned" : "configured");
    }
    if (ownedCheckout) {
      expect(fs.lstatSync(local).ino).toBe(before.ino);
      expect(fs.lstatSync(local).isSymbolicLink()).toBe(kind === "link");
    } else if (kind === "configured") {
      expect(fs.realpathSync(local)).toBe(modules);
      expect(fs.existsSync(path.join(modules, "tsx"))).toBe(false);
    }
  },
);

it("refuses a missing worktree install", () => {
  const { checkout, modules } = fixture();
  const before = fs.statSync(modules);
  expect(() => resolveTsxImport(checkout)).toThrow("pnpm install --frozen-lockfile");
  expect(fs.existsSync(path.join(checkout, "node_modules"))).toBe(false);
  expect(fs.statSync(modules)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
});

it("keeps an existing explicit borrow readable without replacing its link", () => {
  const { checkout, modules, entry } = fixture();
  const link = path.join(checkout, "node_modules");
  fs.symlinkSync(modules, link, process.platform === "win32" ? "junction" : "dir");
  const before = fs.lstatSync(link);
  const target = fs.readlinkSync(link);
  expect(resolveTsxImport(checkout)).toBe(entry);
  expect(fs.lstatSync(link).ino).toBe(before.ino);
  expect(fs.readlinkSync(link)).toBe(target);
});

it("uses owned checkout dependencies when the configured directory contains only metadata", () => {
  const { checkout, modules } = fixture();
  const localModules = path.join(checkout, "node_modules");
  fs.cpSync(modules, localModules, { recursive: true });
  const metadata = path.join(path.dirname(checkout), "metadata");
  writeFiles(metadata, { ".modules.yaml": "virtualStoreDir: .pnpm\n" });
  vi.stubEnv("PNPM_CONFIG_MODULES_DIR", metadata);
  const before = fs.lstatSync(localModules);
  expect(resolveTsxImport(checkout)).toBe(
    pathToFileURL(path.join(localModules, "tsx", "esm.mjs")).href,
  );
  expect(fs.lstatSync(localModules).ino).toBe(before.ino);
  expect(fs.lstatSync(localModules).isSymbolicLink()).toBe(false);
});

it("loads the explicitly configured npm toolchain", () => {
  const { checkout, modules, entry } = fixture();
  vi.stubEnv("npm_config_modules_dir", modules);
  expect(resolveTsxImport(checkout)).toBe(entry);
  expect(fs.realpathSync(path.join(checkout, "node_modules"))).toBe(modules);
});
