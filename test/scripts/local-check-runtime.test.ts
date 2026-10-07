// Local Check Runtime tests cover local check runtime script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalOxlintPolicy,
  applyLocalTsgoPolicy,
  ensureRepoNodeModulesLink,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "../../scripts/lib/local-check-runtime.mts";
import { resolveTsxImport } from "../../scripts/lib/tsx-cli-shim.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const GIB = 1024 ** 3;
const CONSTRAINED_HOST = {
  totalMemoryBytes: 16 * GIB,
  logicalCpuCount: 8,
};
const ROOMY_HOST = {
  totalMemoryBytes: 128 * GIB,
  logicalCpuCount: 16,
};
const throttledGoEnv = { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" };
const explicitGoEnv = { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" };
const unsetGoEnv = { GOMAXPROCS: undefined, GOGC: undefined, GOMEMLIMIT: undefined };
type CheckResources = Parameters<typeof applyLocalTsgoPolicy>[2];
type PolicyCase = [
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  host: CheckResources,
  expectedArgs: string[] | undefined,
  expectedEnv: NodeJS.ProcessEnv,
];

function expectPolicy(
  result: ReturnType<typeof applyLocalTsgoPolicy>,
  args: string[] | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (args) {
    expect(result.args).toEqual(args);
  }
  for (const [key, value] of Object.entries(env)) {
    expect(result.env[key], key).toBe(value);
  }
}

const localTsgoDefaults = [
  "--declaration",
  "false",
  "--incremental",
  "--tsBuildInfoFile",
  ".artifacts/tsgo-cache/root.tsbuildinfo",
];
const localOxlintDefaults = [
  "--type-aware",
  "--tsconfig",
  "config/tsconfig/oxlint.json",
  "--report-unused-disable-directives-severity",
  "error",
];

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_LOCAL_CHECK: "1",
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "OPENCLAW_LOCAL_CHECK_MODE")) {
    delete env.OPENCLAW_LOCAL_CHECK_MODE;
  }
  if (!Object.hasOwn(overrides, "GITHUB_ACTIONS")) {
    delete env.GITHUB_ACTIONS;
  }
  return env;
}

function makeBoundedOxlintEnv(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return makeEnv({
    CI: "true",
    OPENCLAW_LOCAL_CHECK: "0",
    OPENCLAW_OXLINT_BATCH_CONCURRENCY: "1",
    OPENCLAW_OXLINT_BOUNDED_SHARD_ARGS: JSON.stringify(args),
    GOMAXPROCS: undefined,
    GOGC: undefined,
    GOMEMLIMIT: undefined,
    ...overrides,
  });
}

describe("local-check-runtime", () => {
  it("resolves repo tools from the primary checkout for dependency-less worktrees", () => {
    const primaryRoot = createTempDir("openclaw-primary-checkout-");
    const cwd = path.join(primaryRoot, ".codex", "worktrees", "task", "openclaw");
    const commonDir = path.join(primaryRoot, ".git");
    const localPath = path.resolve(cwd, "node_modules", ".bin", "oxlint");
    const primaryPath = path.join(primaryRoot, "node_modules", ".bin", "oxlint");

    expect(
      resolveRepoToolBinPath("oxlint", {
        cwd,
        fileExists: (candidate) => candidate === primaryPath,
        resolveCommonDir: () => commonDir,
      }),
    ).toBe(primaryPath);
    expect(
      resolveRepoToolBinPath("oxlint", {
        cwd,
        fileExists: (candidate) => candidate === localPath || candidate === primaryPath,
        resolveCommonDir: () => commonDir,
      }),
    ).toBe(localPath);
  });

  it.each([
    { platform: "linux" as const, linkType: "dir", owned: false },
    { platform: "win32" as const, linkType: "junction", owned: false },
    { platform: process.platform, linkType: "dir", owned: true },
  ])(
    "preserves declaration dependency ownership on $platform (existing: $owned)",
    ({ platform, linkType, owned }) => {
      const primaryRoot = createTempDir("openclaw-primary-toolchain-");
      const cwd = path.join(primaryRoot, ".artifacts", "declarations");
      const primaryTsgo = path.join(primaryRoot, "node_modules", ".bin", "tsgo");
      const primaryNodeModules = path.join(primaryRoot, "node_modules");
      const localNodeModules = path.join(cwd, "node_modules");
      fs.mkdirSync(path.dirname(primaryTsgo), { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      if (owned) {
        fs.mkdirSync(localNodeModules);
      }
      const linkTypes: Array<Parameters<typeof fs.symlinkSync>[2]> = [];
      const linkOptions = {
        cwd,
        platform,
        symlink: (...args: Parameters<typeof fs.symlinkSync>) => {
          linkTypes.push(args[2]);
          fs.symlinkSync(...args);
        },
      };

      expect(ensureRepoNodeModulesLink(primaryNodeModules, linkOptions)).toBe(localNodeModules);
      if (owned) {
        expect(fs.lstatSync(localNodeModules).isDirectory()).toBe(true);
        expect(fs.lstatSync(localNodeModules).isSymbolicLink()).toBe(false);
      } else {
        expect(fs.realpathSync(localNodeModules)).toBe(fs.realpathSync(primaryNodeModules));
      }

      // The stable link is idempotent for concurrent and later local runners.
      expect(ensureRepoNodeModulesLink(primaryNodeModules, linkOptions)).toBe(localNodeModules);
      expect(linkTypes).toEqual(owned ? [] : [linkType]);
    },
  );
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

  const tsgoCases: Array<[...PolicyCase, alternate?: [string[], string[]]]> = [
    [
      "constrained local host",
      [],
      makeEnv(),
      CONSTRAINED_HOST,
      [...localTsgoDefaults, "--singleThreaded", "--checkers", "1"],
      throttledGoEnv,
    ],
    [
      "disabled local policy",
      [],
      makeEnv({ OPENCLAW_LOCAL_CHECK: "0" }),
      ROOMY_HOST,
      ["--declaration", "false"],
      {},
    ],
    [
      "constrained CI with local safeguards disabled",
      ["-b", "tsconfig.projects.json"],
      makeEnv({ CI: "true", OPENCLAW_LOCAL_CHECK: "0" }),
      CONSTRAINED_HOST,
      [
        "-b",
        "tsconfig.projects.json",
        "--declaration",
        "false",
        "--singleThreaded",
        "--checkers",
        "1",
      ],
      throttledGoEnv,
    ],
    [
      "explicit flags and Go limits",
      ["--checkers", "4", "--singleThreaded", "--pprofDir", "/tmp/existing"],
      makeEnv({ ...explicitGoEnv, OPENCLAW_TSGO_PPROF_DIR: "/tmp/profile" }),
      CONSTRAINED_HOST,
      [
        "--checkers",
        "4",
        "--singleThreaded",
        "--pprofDir",
        "/tmp/existing",
        "--declaration",
        "false",
      ],
      explicitGoEnv,
    ],
    [
      "profiling without a throttled mode",
      ["-p", "tsconfig.ui.json"],
      { OPENCLAW_TSGO_PPROF_DIR: ".artifacts/profiles" },
      ROOMY_HOST,
      ["-p", "tsconfig.ui.json", "--declaration", "false", "--pprofDir", ".artifacts/profiles"],
      { OPENCLAW_LOCAL_CHECK_MODE: undefined, GOMAXPROCS: undefined, GOMEMLIMIT: undefined },
    ],
    [
      "explicit declaration flags",
      ["--declaration"],
      makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "full" }),
      ROOMY_HOST,
      ["--declaration"],
      {},
      [["-d"], ["-d"]],
    ],
    ["roomy local host", [], makeEnv(), ROOMY_HOST, localTsgoDefaults, unsetGoEnv],
    [
      "custom incremental cache",
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "full",
        OPENCLAW_TSGO_BUILD_INFO_FILE: ".artifacts/custom/tsgo.tsbuildinfo",
      }),
      ROOMY_HOST,
      [
        "--declaration",
        "false",
        "--incremental",
        "--tsBuildInfoFile",
        ".artifacts/custom/tsgo.tsbuildinfo",
      ],
      {},
    ],
    [
      "ad hoc invocation without cache reuse",
      ["--extendedDiagnostics"],
      makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "full" }),
      ROOMY_HOST,
      ["--extendedDiagnostics", "--declaration", "false"],
      {},
    ],
    [
      "forced throttling on a roomy host",
      [],
      makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "throttled" }),
      ROOMY_HOST,
      [...localTsgoDefaults, "--singleThreaded", "--checkers", "1"],
      throttledGoEnv,
    ],
    [
      "single CPU",
      [],
      makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "throttled" }),
      { logicalCpuCount: 1, totalMemoryBytes: 16 * GIB },
      undefined,
      { GOMAXPROCS: "1" },
    ],
  ];
  it.each(tsgoCases)(
    "applies tsgo policy for %s",
    (_name, args, env, host, expectedArgs, expectedEnv, alternate) => {
      expectPolicy(applyLocalTsgoPolicy(args, env, host), expectedArgs, expectedEnv);
      if (alternate) {
        expectPolicy(applyLocalTsgoPolicy(alternate[0], env, host), alternate[1], {});
      }
    },
  );

  const oxlintCases: Array<[...PolicyCase, unchangedLimits?: boolean, expectedThreads?: string[]]> =
    [
      [
        "roomy local host",
        [],
        makeEnv(),
        ROOMY_HOST,
        [...localOxlintDefaults, "--threads=1"],
        throttledGoEnv,
      ],
      [
        "explicit thread count and Go limits",
        ["--threads=8"],
        makeEnv(explicitGoEnv),
        ROOMY_HOST,
        ["--threads=8", ...localOxlintDefaults],
        explicitGoEnv,
      ],
      ...[
        { name: "memory-constrained CI runner", ci: "true", cpus: 16, gib: 16, throttled: true },
        { name: "CPU-constrained CI runner", ci: "true", cpus: 4, gib: 32, throttled: true },
        { name: "parallel CI boundary", ci: "true", cpus: 8, gib: 24, throttled: false },
        { name: "disabled local policy", ci: undefined, cpus: 4, gib: 16, throttled: false },
      ].map(({ name, ci, cpus, gib, throttled }): [...PolicyCase, boolean, string[]] => [
        name,
        ["--threads=1"],
        makeEnv({ CI: ci, OPENCLAW_LOCAL_CHECK: "0", ...unsetGoEnv, GOMAXPROCS: "2" }),
        { logicalCpuCount: cpus, totalMemoryBytes: gib * GIB },
        undefined,
        {
          GOMAXPROCS: "2",
          GOGC: throttled ? "30" : undefined,
          GOMEMLIMIT: throttled ? "3GiB" : undefined,
        },
        true,
        ["--threads=1"],
      ]),
      [
        "explicit constrained GitHub Actions limits",
        ["--threads=3"],
        makeEnv({
          CI: undefined,
          GITHUB_ACTIONS: "true",
          OPENCLAW_LOCAL_CHECK: "0",
          ...explicitGoEnv,
        }),
        { logicalCpuCount: 4, totalMemoryBytes: 16 * GIB },
        undefined,
        explicitGoEnv,
        false,
        ["--threads=3"],
      ],
      [
        "forced full speed",
        [],
        makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "full" }),
        ROOMY_HOST,
        localOxlintDefaults,
        { GOGC: undefined, GOMEMLIMIT: undefined },
      ],
    ];
  it.each(oxlintCases)(
    "applies oxlint policy for %s",
    (_name, args, env, host, expectedArgs, expectedEnv, unchangedLimits, expectedThreads) => {
      const result = applyLocalOxlintPolicy(args, env, host);
      expectPolicy(result, expectedArgs, expectedEnv);
      if (expectedThreads) {
        expect(result.args.filter((arg) => arg.startsWith("--threads"))).toEqual(expectedThreads);
      }
      if (unchangedLimits) {
        expect(env.GOGC).toBeUndefined();
        expect(env.GOMEMLIMIT).toBeUndefined();
        expect(result.args).toContain("--type-aware");
      }
    },
  );

  it.each([
    { name: "ancestor ceiling", total: 64, capacity: 7, throttled: true },
    { name: "unresolved capacity", total: 64, capacity: null, throttled: true },
    { name: "physical-only caller", total: 64, capacity: undefined, throttled: false },
    { name: "roomy capacity", total: 64, capacity: 48, throttled: false },
    { name: "smaller physical host", total: 16, capacity: 64, throttled: true },
  ])("sizes compiler workers from $name instead of remaining memory", (row) => {
    for (const ci of [undefined, "true"]) {
      const host = {
        logicalCpuCount: 16,
        totalMemoryBytes: row.total * GIB,
        memoryCapacityBytes: row.capacity == null ? row.capacity : row.capacity * GIB,
        memoryLimitBytes: GIB,
      };
      const inputEnv = makeEnv({
        CI: ci,
        OPENCLAW_LOCAL_CHECK: ci ? "0" : "1",
        GOMAXPROCS: undefined,
        GOGC: undefined,
        GOMEMLIMIT: undefined,
      });
      const tsgo = applyLocalTsgoPolicy(["--noEmit"], inputEnv, host);
      const oxlint = applyLocalOxlintPolicy([], inputEnv, host);
      for (const [result, flag, throttled] of [
        [tsgo, "--singleThreaded", row.throttled],
        // Local Oxlint remains throttled by default, including on roomy machines.
        [oxlint, "--threads=1", ci ? row.throttled : true],
      ] as const) {
        expect(result.args.includes(flag)).toBe(throttled);
        expect(result.env.GOMEMLIMIT).toBe(throttled ? "3GiB" : undefined);
        expect(result.env.GOMAXPROCS).toBe(throttled ? "2" : undefined);
      }
    }
  });

  type BoundedCase = {
    name: string;
    args?: string[];
    host?: Partial<CheckResources>;
    env?: NodeJS.ProcessEnv;
    admission?: "missing" | "changed";
    threads?: "1" | "2";
    expectedEnv?: NodeJS.ProcessEnv;
    measured?: boolean;
    unmeasuredArgs?: string[][];
  };
  const boundedCases: BoundedCase[] = [
    ...["config/tsconfig/oxlint.core.json", "extensions/tsconfig.json"].map(
      (config): BoundedCase => ({
        name: `admitted ${config}`,
        args: ["--tsconfig", config],
        host: { memoryCapacityBytes: 15 * GIB, memoryLimitBytes: 14 * GIB },
        threads: "2",
        measured: true,
        expectedEnv: { GOMAXPROCS: "4", GOGC: "100", GOMEMLIMIT: "8GiB" },
      }),
    ),
    { name: "two CPUs", host: { logicalCpuCount: 2 }, threads: "1" },
    { name: "8 GiB capacity", host: { memoryCapacityBytes: 8 * GIB }, threads: "1" },
    { name: "unknown capacity", host: { memoryCapacityBytes: null }, threads: "1" },
    { name: "Windows", host: { platform: "win32" }, threads: "1" },
    { name: "concurrent Programs", env: { OPENCLAW_OXLINT_BATCH_CONCURRENCY: "2" }, threads: "1" },
    {
      name: "explicit limits and unmeasured configurations",
      args: ["--tsconfig", "extensions/tsconfig.json", "--threads=1"],
      env: { GOMAXPROCS: "1", GOGC: "20", GOMEMLIMIT: "2GiB" },
      expectedEnv: { GOMAXPROCS: "1", GOGC: "20", GOMEMLIMIT: "2GiB" },
      threads: "1",
      unmeasuredArgs: [
        ["--tsconfig", "test/tsconfig/tsconfig.test.root.json"],
        ["--tsconfig", "extensions/tsconfig.json", "--threads=4"],
        ["--tsconfig", "extensions/tsconfig.json", "--", "--threads=4"],
      ],
    },
    ...[
      { config: "config/tsconfig/oxlint.core.json", available: 13 * GIB, admission: undefined },
      { config: "extensions/tsconfig.json", available: 9 * GIB, admission: undefined },
      { config: "extensions/tsconfig.json", available: null, admission: undefined },
      { config: "extensions/tsconfig.json", available: 16 * GIB, admission: "missing" as const },
      { config: "extensions/tsconfig.json", available: 16 * GIB, admission: "changed" as const },
    ].map(({ config, available, admission }): BoundedCase => ({
      name: `${config}, ${available} available, ${admission ?? "bound"} admission`,
      args: ["--tsconfig", config, "extensions/example"],
      host: { memoryLimitBytes: available },
      admission,
      threads: "1",
    })),
  ];
  it.each(boundedCases)("applies the bounded CI budget for $name", (row) => {
    const args = [...(row.args ?? ["--tsconfig=extensions/tsconfig.json"])];
    const inputEnv = makeBoundedOxlintEnv(args, row.env);
    if (row.admission === "missing") {
      delete inputEnv.OPENCLAW_OXLINT_BOUNDED_SHARD_ARGS;
    } else if (row.admission === "changed") {
      args.push("scripts/unmeasured.mts");
    }
    const host: CheckResources = {
      logicalCpuCount: 4,
      totalMemoryBytes: 16 * GIB,
      memoryCapacityBytes: 16 * GIB,
      memoryLimitBytes: 16 * GIB,
      platform: "linux",
      ...row.host,
    };
    const result = applyLocalOxlintPolicy(args, inputEnv, host);
    expect(result.env).toMatchObject(row.expectedEnv ?? throttledGoEnv);
    if (row.threads) {
      expect(result.args).toContain(`--threads=${row.threads}`);
    }
    if (row.measured) {
      expect(result.args).toContain("--type-aware");
      expect(inputEnv.GOMEMLIMIT).toBeUndefined();
    }
    for (const unmeasured of row.unmeasuredArgs ?? []) {
      expect(
        applyLocalOxlintPolicy(unmeasured, makeBoundedOxlintEnv(unmeasured), host).env,
      ).toMatchObject(throttledGoEnv);
    }
  });

  it.each([
    {
      name: "default Go settings",
      goEnv: { GOMAXPROCS: undefined, GOGC: undefined, GOMEMLIMIT: undefined },
      prepGoEnv: { GOMAXPROCS: null, GOGC: null, GOMEMLIMIT: null },
      lintGoEnv: {
        GOMAXPROCS: String(Math.min(2, Math.max(1, os.availableParallelism()))),
        GOGC: "30",
        GOMEMLIMIT: "3GiB",
      },
    },
    {
      name: "explicit user Go settings",
      goEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
      prepGoEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
      lintGoEnv: { GOMAXPROCS: "3", GOGC: "80", GOMEMLIMIT: "5GiB" },
    },
  ])(
    "keeps prep and oxlint resource policies separate with $name",
    ({ goEnv, prepGoEnv, lintGoEnv }) => {
      const cwd = createTempDir("openclaw-oxlint-go-limit-");
      // Keep artifact ownership inside this fixture when its temp directory has a checkout ancestor.
      fs.mkdirSync(path.join(cwd, ".git"));
      const binDir = path.join(cwd, "node_modules", ".bin");
      const scriptsDir = path.join(cwd, "scripts");
      const capturePath = path.join(cwd, "children.jsonl");
      const oxlintPath = path.join(binDir, "oxlint");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(scriptsDir, { recursive: true });
      const captureSource = `
const goEnv = Object.fromEntries(["GOMAXPROCS", "GOGC", "GOMEMLIMIT"].map(key => [key, process.env[key] ?? null]));
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({ step, goEnv, args: process.argv.slice(2) }) + "\\n");
`;
      fs.writeFileSync(
        path.join(scriptsDir, "prepare-extension-package-boundary-artifacts.mts"),
        `import fs from "node:fs";\nconst step = "prep";\n${captureSource}`,
        "utf8",
      );
      fs.writeFileSync(
        oxlintPath,
        `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst step = "lint";\n${captureSource}`,
        "utf8",
      );
      fs.chmodSync(oxlintPath, 0o755);
      const env = makeEnv({
        CAPTURE_PATH: capturePath,
        OPENCLAW_OXLINT_SKIP_PREPARE: undefined,
        ...goEnv,
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
        { step: "prep", goEnv: prepGoEnv, args: ["--mode=package-boundary"] },
        {
          step: "lint",
          goEnv: lintGoEnv,
          args: [
            "--tsconfig",
            "extensions/tsconfig.json",
            "--type-aware",
            "--report-unused-disable-directives-severity",
            "error",
            "--threads=1",
          ],
        },
      ]);
    },
  );

  it.each([undefined, "--format", "--format=json", "-f", "-f=json", "-fjson"])(
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
});

describe("Tooling bootstrap dependency ownership", () => {
  afterEach(() => vi.unstubAllEnvs());

  function fixture() {
    vi.stubEnv("PNPM_CONFIG_MODULES_DIR", undefined);
    vi.stubEnv("pnpm_config_modules_dir", undefined);
    vi.stubEnv("npm_config_modules_dir", undefined);
    const root = fs.realpathSync(createTempDir("openclaw-toolchain-ownership-"));
    const primary = path.join(root, "primary");
    const checkout = path.join(root, "checkout");
    fs.mkdirSync(checkout);
    expect(spawnSync("git", ["init", "--quiet", primary]).status).toBe(0);
    const gitdir = path.join(primary, ".git", "worktrees", "task");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(gitdir, "gitdir"), `${checkout}/.git\n`);
    fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${gitdir}\n`);
    const modules = path.join(primary, "node_modules");
    const tsx = path.join(modules, "tsx");
    fs.mkdirSync(tsx, { recursive: true });
    fs.writeFileSync(
      path.join(tsx, "package.json"),
      JSON.stringify({ name: "tsx", type: "module", exports: { "./esm": "./esm.mjs" } }),
    );
    fs.writeFileSync(path.join(tsx, "esm.mjs"), "export {};\n");
    return { checkout, modules, entry: pathToFileURL(path.join(tsx, "esm.mjs")).href };
  }

  function nativeFixture() {
    const root = fs.realpathSync(createTempDir("openclaw-native-toolchain-"));
    const checkout = path.join(root, "checkout");
    const lib = path.join(checkout, "scripts", "lib");
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(path.join(checkout, "src", "infra"), { recursive: true });
    fs.copyFileSync(
      path.resolve("src/infra/node-compiler-policy.mjs"),
      path.join(checkout, "src", "infra", "node-compiler-policy.mjs"),
    );
    for (const file of ["tsx-cli-shim.mjs", "local-check-runtime.mts"]) {
      fs.copyFileSync(path.resolve("scripts", "lib", file), path.join(lib, file));
    }
    fs.writeFileSync(
      path.join(checkout, "scripts", "entry.mjs"),
      'import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs"; await runNodeCliShim(import.meta.url, { implementation: "./implementation.mts" });\n',
    );
    fs.writeFileSync(
      path.join(checkout, "scripts", "implementation.mts"),
      'import value from "fixture-dependency"; console.log(value);\n',
    );
    const configured = " modules";
    const modules = path.join(checkout, configured);
    const dependency = path.join(modules, "fixture-dependency");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "fixture-dependency", type: "module", exports: "./index.js" }),
    );
    fs.writeFileSync(path.join(dependency, "index.js"), 'export default "configured";\n');
    const run = (overrides: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [path.join(checkout, "scripts", "entry.mjs")], {
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
    return { checkout, modules, configured, run };
  }

  it.each(["PNPM_CONFIG_MODULES_DIR", "pnpm_config_modules_dir", "npm_config_modules_dir"])(
    "loads native child packages without TSX through %s, relative to the shim checkout",
    (key) => {
      const { checkout, modules, configured, run } = nativeFixture();
      const result = run({ [key]: configured });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("configured");
      expect(fs.realpathSync(path.join(checkout, "node_modules"))).toBe(modules);
      expect(fs.existsSync(path.join(modules, "tsx"))).toBe(false);
    },
  );

  it.each(["directory", "link"])("keeps native child dependencies in the owned %s", (kind) => {
    const { checkout, modules, configured, run } = nativeFixture();
    const owned = path.join(checkout, "owned");
    fs.cpSync(modules, owned, { recursive: true });
    fs.writeFileSync(
      path.join(owned, "fixture-dependency", "index.js"),
      'export default "owned";\n',
    );
    const local = path.join(checkout, "node_modules");
    if (kind === "link") {
      fs.symlinkSync(owned, local, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.renameSync(owned, local);
    }
    const before = fs.lstatSync(local);
    const result = run({ PNPM_CONFIG_MODULES_DIR: configured });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("owned");
    expect(fs.lstatSync(local).ino).toBe(before.ino);
    expect(fs.lstatSync(local).isSymbolicLink()).toBe(kind === "link");
  });

  it.each([false, true])(
    "preserves native empty primary alias with npm fallback=%s",
    (fallback) => {
      const { checkout, configured, run } = nativeFixture();
      const result = run({
        PNPM_CONFIG_MODULES_DIR: "",
        pnpm_config_modules_dir: configured,
        npm_config_modules_dir: fallback ? configured : undefined,
      });
      expect(result.status, result.stderr).toBe(fallback ? 0 : 1);
      if (fallback) {
        expect(result.stdout.trim()).toBe("configured");
      } else {
        expect(result.stderr).toContain("Cannot find package 'fixture-dependency'");
        expect(fs.existsSync(path.join(checkout, "node_modules"))).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "refuses a missing worktree install with an empty override=%s",
    (emptyOverride) => {
      const { checkout, modules } = fixture();
      if (emptyOverride) {
        vi.stubEnv("PNPM_CONFIG_MODULES_DIR", "");
        vi.stubEnv("pnpm_config_modules_dir", modules);
      }
      const before = fs.statSync(modules);
      expect(() => resolveTsxImport(checkout)).toThrow("pnpm install --frozen-lockfile");
      expect(fs.existsSync(path.join(checkout, "node_modules"))).toBe(false);
      expect(fs.statSync(modules).ino).toBe(before.ino);
      expect(fs.statSync(modules).mtimeMs).toBe(before.mtimeMs);
    },
  );

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
    fs.mkdirSync(metadata);
    fs.writeFileSync(path.join(metadata, ".modules.yaml"), "virtualStoreDir: .pnpm\n");
    vi.stubEnv("PNPM_CONFIG_MODULES_DIR", metadata);
    const before = fs.lstatSync(localModules);
    expect(resolveTsxImport(checkout)).toBe(
      pathToFileURL(path.join(localModules, "tsx", "esm.mjs")).href,
    );
    expect(fs.lstatSync(localModules).ino).toBe(before.ino);
    expect(fs.lstatSync(localModules).isSymbolicLink()).toBe(false);
  });

  it.each([
    { key: "PNPM_CONFIG_MODULES_DIR", relative: false },
    { key: "pnpm_config_modules_dir", relative: false },
    { key: "npm_config_modules_dir", relative: false },
    { key: "PNPM_CONFIG_MODULES_DIR", relative: true },
  ])(
    "loads the explicitly configured toolchain ($key, relative: $relative)",
    ({ key, relative }) => {
      const { checkout, modules, entry } = fixture();
      const target = relative ? path.join(checkout, " modules") : modules;
      if (relative) {
        fs.renameSync(modules, target);
      }
      vi.stubEnv(key, relative ? " modules" : modules);
      expect(resolveTsxImport(checkout)).toBe(
        relative ? pathToFileURL(path.join(target, "tsx", "esm.mjs")).href : entry,
      );
      expect(fs.realpathSync(path.join(checkout, "node_modules"))).toBe(target);
    },
  );
});
