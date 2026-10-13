import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import { readProcessMemoryCapacity } from "../../scripts/lib/process-memory.mts";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
} from "../../scripts/lib/tsdown-config-groups.mts";
import {
  cleanTsdownOutputRoots,
  createTsdownOutputScanner,
  describeInsufficientTsdownHeap,
  listTsdownOutputRoots,
  parseTsdownBuildArgs,
  prepareTsdownBuildExecution,
  pruneStaleRootChunkFiles,
  pruneStaleRuntimeSymlinks,
  pruneUntrackedGeneratedSourceDeclarations,
  resolveTsdownBuildInvocation,
  resolveTsdownBuildInvocations,
  resolveTsdownBuildPlan,
  resolveTsdownCleanOutputRoots,
  runTsdownBuild,
  runTsdownBuildInvocation as runTsdownBuildInvocationImpl,
  sanitizeTsdownBuildOutputRoots,
} from "../../scripts/tsdown-build.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { createSourcePluginDependenciesFixture } from "./source-plugin-dependencies-fixture.js";

beforeEach(() => {
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
});

const fixture = createFixtureLifetime();
const { createTempDir } = fixture;
afterEach(() => fixture.cleanup());
const runTsdownBuildInvocation = (...args: Parameters<typeof runTsdownBuildInvocationImpl>) =>
  fixture.track(runTsdownBuildInvocationImpl(...args));
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function receiptFixtureScript(lines: string[]) {
  return [
    fixtureReceiptClientSource(receipts.endpoint),
    "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    ...lines,
  ].join("\n");
}

async function fixtureEventBeforeSettlement(
  record: string,
  text: string,
  operation: Promise<unknown>,
  signal: AbortSignal,
) {
  await withinTest(
    Promise.race([
      receipts.waitFor(record, text),
      operation.then(() => {
        // Receipt and process output use separate pipes. The fixture writes this
        // record before it can exit or let the owning operation settle.
        if (
          !fs.existsSync(record) ||
          !(text === ""
            ? Number(fs.readFileSync(record, "utf8")) > 0
            : fs.readFileSync(record, "utf8").includes(text))
        ) {
          throw new Error(
            text === "" ? `timeout waiting for pid in ${record}` : `timeout waiting for ${record}`,
          );
        }
      }),
    ]),
    signal,
  );
}

function waitForForeignProcessExit(pid: number, signal: AbortSignal): Promise<void> {
  // The product owns these child handles, and deliberate parent death or rescue
  // SIGKILL leaves no test-owned exit event. Only test cancellation bounds reaping.
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const abort = () => finish(new Error(`process still alive: ${pid}`, { cause: signal.reason }));
    const check = () => {
      if (!isProcessAlive(pid)) {
        finish();
      } else if (signal.aborted) {
        abort();
      } else {
        timer = setTimeout(check, 5);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const TEST_PHYSICAL_MEMORY_BYTES = 16 * GiB;
// Memory detection is a process-global input. Freeze it for this suite so fake cgroup
// fixtures prove only their declared hierarchy instead of inheriting the runner's RAM.
vi.spyOn(os, "totalmem").mockReturnValue(TEST_PHYSICAL_MEMORY_BYTES);
const readFileSync = fs.readFileSync.bind(fs);
vi.spyOn(fs, "readFileSync").mockImplementation(
  (filePath, options?: BufferEncoding | fs.ReadFileSyncOptions | null) =>
    filePath === "/proc/meminfo" && options === "utf8"
      ? "MemTotal:       16777216 kB\nMemAvailable:   16777216 kB\n"
      : readFileSync(
          filePath,
          typeof options === "string" ? { encoding: options } : (options ?? {}),
        ),
);
const NO_MEMORY_LIMIT = {
  availableMemoryBytes: TEST_PHYSICAL_MEMORY_BYTES,
  cgroupMemoryLimitPaths: [],
  constrainedMemoryBytes: 0,
  physicalMemoryBytes: TEST_PHYSICAL_MEMORY_BYTES,
  procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
};

function createMemoryFileSystem(
  files: ReadonlyMap<string, string | Error>,
  onRead?: (filePath: string) => void,
) {
  return {
    readFileSync(filePath: string) {
      onRead?.(filePath);
      const contents = files.get(filePath);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
      }
      if (contents instanceof Error) {
        throw contents;
      }
      return contents;
    },
  };
}

function filtersOf(invocations: ReturnType<typeof resolveTsdownBuildInvocations>) {
  return invocations.map(({ args }) => args[args.indexOf("--filter") + 1]);
}

type TsdownInvocationParams = NonNullable<Parameters<typeof resolveTsdownBuildInvocation>[0]>;

function resolveTestNodeOptions(params: TsdownInvocationParams) {
  return resolveTsdownBuildInvocation({
    nodeExecPath: "/usr/bin/node",
    env: {},
    ...params,
  }).options.env.NODE_OPTIONS;
}

function writeFixtureFile(root: string, relative: string, contents: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function expectPathMissing(targetPath: string) {
  expect(() => fs.statSync(targetPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
}

describe("resolveTsdownBuildInvocation", () => {
  it("parses wrapper help before any tsdown work", () => {
    expect(parseTsdownBuildArgs(["--help"])).toEqual({ forwardedArgs: [], help: true });
    expect(parseTsdownBuildArgs(["--format", "esm"])).toEqual({
      forwardedArgs: ["--format", "esm"],
      help: false,
    });
  });

  it("prints wrapper help without invoking pnpm or tsdown", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/tsdown-build.mts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/tsdown-build.mts");
    expect(result.stdout).not.toContain("Scope:");
    expect(result.stdout).not.toContain("pnpm");
  });

  it("serializes declaration graphs when --dts overrides the no-DTS environment", () => {
    const results = resolveTsdownBuildInvocations({
      args: ["--dts"],
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      ...NO_MEMORY_LIMIT,
    });

    expect(results).toHaveLength(3 + TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length);
    expect(results[1]?.args).toEqual(expect.arrayContaining(["--filter", "openclaw-packages"]));
    expect(results[1]?.args).toEqual(expect.arrayContaining(["--concurrency", "1"]));
    expect(results[2]?.args).toEqual(expect.arrayContaining(["--filter", "openclaw-unified"]));
    expect(results.at(-1)?.args).toEqual(
      expect.arrayContaining(["--filter", TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.at(-1)]),
    );
  });

  it.each([...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS, ...TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS])(
    "honors --dts for the single %s declaration selection",
    (group) => {
      const results = resolveTsdownBuildInvocations({
        args: ["--config", "tsdown.config.ts", "--filter", group, "--dts"],
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
        ...NO_MEMORY_LIMIT,
      });
      expect(filtersOf(results)).toEqual([group]);
      expect(results[0]?.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe("0");
    },
  );

  it.each([{ watch: [] }, { watch: ["--watch"] }])(
    "keeps --no-dts out of canonical config construction (watch=$watch)",
    ({ watch }) => {
      const results = resolveTsdownBuildInvocations({
        args: ["--config", "tsdown.config.ts", "--no-dts", ...watch],
        env: {},
        ...NO_MEMORY_LIMIT,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe("1");
    },
  );

  it("serializes an explicit declaration subset in dependency order", () => {
    const args = [
      "--config",
      "tsdown.config.ts",
      "--filter",
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.toReversed().flatMap((group) => ["--filter", group]),
      "--filter",
      TSDOWN_PACKAGE_CONFIG_GROUP,
      "--format",
      "esm",
    ];
    const results = resolveTsdownBuildInvocations({ args, env: {}, ...NO_MEMORY_LIMIT });
    expect(filtersOf(results)).toEqual([
      TSDOWN_PACKAGE_CONFIG_GROUP,
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
    for (const result of results) {
      expect(result.args).toEqual(expect.arrayContaining(["--config", "tsdown.config.ts"]));
      expect(result.args.slice(-2)).toEqual(["--format", "esm"]);
    }
  });

  it("cleans an explicit output directory once before serialized children", () => {
    const args = ["--out-dir", "tmp/custom-dist", "--clean"];
    const results = resolveTsdownBuildInvocations({ args, env: {}, ...NO_MEMORY_LIMIT });

    expect(resolveTsdownCleanOutputRoots(args)).toEqual(["tmp/custom-dist"]);
    expect(results.length).toBeGreaterThan(1);
    for (const result of results) {
      expect(result.args).toContain("--no-clean");
      expect(result.args).not.toContain("--clean");
    }
  });

  it.each<[string, string[], TsdownInvocationParams]>([
    ["short watch", ["-c", "tsdown.config.ts", "-w"], { env: {}, ...NO_MEMORY_LIMIT }],
    ["assigned short watch", ["-c", "tsdown.config.ts", "-w=src"], { env: {}, ...NO_MEMORY_LIMIT }],
    [
      "config-free positional watch",
      ["--no-config", "packages/normalization-core/src/mountinfo-path.ts", "--watch"],
      { env: {}, cgroupMemoryLimitBytes: 4 * GiB },
    ],
    [
      "custom config",
      ["-c", "custom.tsdown.config.ts", "--clean"],
      {
        platform: "linux",
        nodeExecPath: "/usr/bin/node",
        env: {},
        cgroupMemoryLimitBytes: 4 * GiB,
      },
    ],
  ])("keeps %s in one owning process", (_name, args, params) => {
    const { invocations, heapShortfall } = resolveTsdownBuildPlan({ args, ...params });
    expect(heapShortfall).toBeNull();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args.slice(-args.length)).toEqual(args);
    if (args[1] === "tsdown.config.ts") {
      expect(
        invocations[0]?.args.filter((_arg, index, all) => all[index - 1] === "--filter"),
      ).toEqual([
        TSDOWN_PACKAGE_CONFIG_GROUP,
        TSDOWN_UNIFIED_CONFIG_GROUP,
        ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
      ]);
    }
    if (args.includes("--clean")) {
      expect(invocations[0]?.args.indexOf("--clean")).toBeGreaterThan(
        invocations[0]?.args.indexOf("--no-clean") ?? -1,
      );
    }
  });

  it.each([{ extra: [] }, { extra: ["--watch"] }])(
    "rejects overlapping full and SDK declaration selections $extra",
    ({ extra }) => {
      expect(() =>
        resolveTsdownBuildInvocations({
          args: [
            "--config",
            "tsdown.config.ts",
            ...extra,
            ...[
              ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
              ...TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
            ].flatMap((group) => ["--filter", group]),
          ],
          env: {},
          ...NO_MEMORY_LIMIT,
        }),
      ).toThrow("full declarations already include the SDK");
    },
  );

  it("admits the full declaration writer while retaining the SDK-only selection", () => {
    for (const group of [
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
      ...TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
    ]) {
      const plan = resolveTsdownBuildPlan({
        args: ["--config", "tsdown.config.ts", "--filter", group],
        env: {},
        cgroupMemoryLimitBytes: 4 * GiB,
      });
      expect(Boolean(plan.heapShortfall?.fatal)).toBe(
        TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.some((name) => name === group),
      );
      expect(filtersOf(plan.invocations)).toEqual([group]);
    }
  });

  it("rejects default watch mode before splitting long-lived watchers", () => {
    expect(() =>
      resolveTsdownBuildInvocations({ args: ["--watch=src"], env: {}, ...NO_MEMORY_LIMIT }),
    ).toThrow("watch mode requires an explicit --config/-c or --no-config selector");
  });

  it("freezes one heap budget for the complete default plan", () => {
    let memoryReads = 0;
    const args = ["--format", "esm", "src/index.ts"];
    const result = resolveTsdownBuildPlan({
      args,
      env: {},
      cgroupMemoryLimitPaths: ["/test/memory.max"],
      fs: {
        readFileSync(filePath: string) {
          if (filePath !== "/test/memory.max") {
            throw new Error(`unexpected path ${filePath}`);
          }
          return `${(++memoryReads === 1 ? 5 : 4) * GiB}`;
        },
      },
    });
    expect(memoryReads).toBe(1);
    expect(result.heapShortfall).toBeNull();
    expect(result.invocations[0]?.args).toEqual(
      expect.arrayContaining(["--config", "tsdown.ai.config.ts"]),
    );
    expect(filtersOf(result.invocations.slice(1))).toEqual([
      TSDOWN_PACKAGE_CONFIG_GROUP,
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
    expect(result.invocations[1]?.args).toEqual(expect.arrayContaining(["--concurrency", "1"]));
    expect(result.invocations[2]?.args).not.toContain("--concurrency");
    for (const invocation of result.invocations) {
      expect(invocation.args.slice(-args.length)).toEqual(args);
      expect(invocation.options.env.NODE_OPTIONS).toBe("--max-old-space-size=4352");
    }
  });

  it("applies admission to explicit and implicit unified plans", () => {
    const result = resolveTsdownBuildPlan({
      args: [
        "--config=tsdown.config.ts",
        "--filter",
        TSDOWN_UNIFIED_CONFIG_GROUP,
        "--format",
        "esm",
      ],
      env: {},
      cgroupMemoryLimitBytes: 4 * GiB,
    });
    expect(result.heapShortfall?.fatal).toBe(true);
    expect(filtersOf(result.invocations)).toEqual([
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
    for (const invocation of result.invocations) {
      expect(invocation.args.slice(-2)).toEqual(["--format", "esm"]);
    }
    const args = ["-F", TSDOWN_UNIFIED_CONFIG_GROUP];
    const implicit = resolveTsdownBuildPlan({ args, env: {}, cgroupMemoryLimitBytes: 4 * GiB });
    expect(implicit.heapShortfall?.fatal).toBe(true);
    expect(implicit.invocations).toHaveLength(2);
    expect(implicit.invocations[0]?.args).not.toEqual(expect.arrayContaining(args));
    expect(implicit.invocations[1]?.args.slice(-args.length)).toEqual(args);
  });

  it("admits reversed mixed-syntax filters and cleans the complete output set", () => {
    const args = [`-F=${TSDOWN_UNIFIED_CONFIG_GROUP}`, "--filter", TSDOWN_PACKAGE_CONFIG_GROUP];
    const result = resolveTsdownBuildPlan({
      args,
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.heapShortfall?.fatal).toBe(true);
    expect(
      result.invocations
        .slice(1)
        .map((invocation) =>
          invocation.args.filter(
            (_arg, index, invocationArgs) => invocationArgs[index - 1] === "--filter",
          ),
        ),
    ).toEqual([[TSDOWN_PACKAGE_CONFIG_GROUP], [TSDOWN_UNIFIED_CONFIG_GROUP]]);
    expect(new Set(resolveTsdownCleanOutputRoots(args))).toEqual(new Set(listTsdownOutputRoots()));
  });

  it.each([
    ["explicit", ["--config", "tsdown.config.ts"]],
    ["default", []],
  ])("preserves tsdown OR semantics for %s config with an unmatched filter", (_label, config) => {
    const args = [...config, "--filter", TSDOWN_PACKAGE_CONFIG_GROUP, "--filter", "missing-group"];

    const results = resolveTsdownBuildInvocations({ args, env: {}, ...NO_MEMORY_LIMIT });

    expect(results).toHaveLength(config.length === 0 ? 2 : 1);
    expect(results.at(-1)?.args.slice(-args.length)).toEqual(args);
  });

  it("applies admission when tsdown selects the root config by cwd", () => {
    const args = ["--config", "tsdown.config.ts", "--filter", ".", "--filter", "missing"];
    const result = resolveTsdownBuildPlan({
      args,
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.heapShortfall?.fatal).toBe(true);
    expect(filtersOf(result.invocations)).toEqual([
      TSDOWN_PACKAGE_CONFIG_GROUP,
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
    expect(new Set(resolveTsdownCleanOutputRoots(args))).toEqual(
      new Set(listTsdownOutputRoots().filter((root) => root !== "packages/ai/dist")),
    );
    expect(
      new Set(resolveTsdownCleanOutputRoots([...args, "--filter", TSDOWN_PACKAGE_CONFIG_GROUP])),
    ).toEqual(new Set(listTsdownOutputRoots().filter((root) => root !== "packages/ai/dist")));

    const defaultConfigPlan = resolveTsdownBuildPlan({
      args: ["--filter=."],
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    expect(defaultConfigPlan.heapShortfall?.fatal).toBe(true);
    expect(defaultConfigPlan.invocations).toHaveLength(1 + result.invocations.length);
    expect(
      defaultConfigPlan.invocations.slice(1).map((invocation) => {
        return invocation.args.filter(
          (_arg, index, invocationArgs) => invocationArgs[index - 1] === "--filter",
        );
      }),
    ).toEqual([
      [TSDOWN_PACKAGE_CONFIG_GROUP],
      [TSDOWN_UNIFIED_CONFIG_GROUP],
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.map((group) => [group]),
    ]);
    expect(
      new Set(
        resolveTsdownCleanOutputRoots(["--filter=.", `--filter=${TSDOWN_PACKAGE_CONFIG_GROUP}`]),
      ),
    ).toEqual(new Set(listTsdownOutputRoots()));
  });

  it("applies admission to the unfiltered canonical config but not a package-only selector", () => {
    const full = resolveTsdownBuildPlan({
      args: ["-c=.", "--clean"],
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const packages = resolveTsdownBuildPlan({
      args: ["--config", "tsdown.config.ts", "--filter", TSDOWN_PACKAGE_CONFIG_GROUP],
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    for (const invocation of full.invocations) {
      expect(invocation.args).toContain("--no-clean");
      expect(invocation.args).not.toContain("--clean");
    }
    expect(full.heapShortfall?.fatal).toBe(true);
    expect(full.invocations).toHaveLength(2 + TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length);
    expect(filtersOf(full.invocations)).toEqual([
      TSDOWN_PACKAGE_CONFIG_GROUP,
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
    expect(packages.heapShortfall).toBeNull();
    expect(packages.invocations).toHaveLength(1);
  });

  it.each([
    ["Docker default", [], { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" }],
    ["CLI override", ["--no-dts"], {}],
  ])("applies the unified-runtime threshold to a %s plan", (_label, args, env) => {
    const result = resolveTsdownBuildPlan({
      args,
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      env,
      cgroupMemoryLimitBytes: 2 * 1024 * 1024 * 1024,
    });

    for (const invocation of result.invocations) {
      expect(invocation.args).not.toContain("--concurrency");
    }
    expect(result.maxOldSpaceMb).toBe(1280);
    expect(result.heapShortfall?.fatal).toBe(true);
    expect(result.invocations).toHaveLength(2);
    expect(result.invocations[0]?.args).toEqual(
      expect.arrayContaining(["--config", "tsdown.ai.config.ts"]),
    );
    expect(result.invocations[1]?.args).not.toContain("--filter");
  });

  it("keeps the selected Windows runtime and literal compiler arguments", () => {
    const args = ["--format", "esm", "--concurrency", "2"];
    const result = resolveTsdownBuildInvocation({
      args,
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      env: { npm_execpath: "/unrelated/pnpm.cjs" },
      ...NO_MEMORY_LIMIT,
    });
    expect(result.command).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(result.args).toEqual([
      "node_modules/tsdown/dist/run.mjs",
      "--config-loader",
      "unrun",
      "--logLevel",
      "warn",
      "--no-clean",
      ...args,
    ]);
    expect(result.options).toEqual({
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: undefined,
      env: { NODE_OPTIONS: "--max-old-space-size=8192", npm_execpath: "/unrelated/pnpm.cjs" },
    });
  });

  it.each([
    [
      "mixed config selectors",
      ["--config", "tsdown.config.ts", "--no-config"],
      "only one --config/-c/--no-config selector",
    ],
    ["flag-valued output directory", ["--out-dir", "--watch"], "one concrete --out-dir/-d value"],
    ["empty assigned output directory", ["-d="], "one concrete --out-dir/-d value"],
    [
      "duplicate output directories",
      ["--out-dir", "first", "-d=second"],
      "only one --out-dir/-d value",
    ],
    ["missing filter", ["--filter"], "one concrete --filter/-F value"],
  ])("rejects %s before cleanup", (_label, args, message) => {
    const cleanup = vi.fn();
    expect(() =>
      prepareTsdownBuildExecution({ args, env: {}, ...NO_MEMORY_LIMIT }, { cleanup }),
    ).toThrow(message);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("raises a split inherited heap to the build default", () => {
    expect(
      resolveTestNodeOptions({
        ...NO_MEMORY_LIMIT,
        env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size 4096" },
      }),
    ).toBe("--trace-warnings --max-old-space-size=12288");
  });

  it("deducts competing cgroup usage while crediting inactive files and wrapper RSS", () => {
    const files = new Map([
      ["/test/memory.max", `${5 * GiB}`],
      ["/test/memory.current", `${1664 * MiB}`],
      [
        "/test/memory.stat",
        `anon ${512 * MiB}\nshmem ${256 * MiB}\nfile ${768 * MiB}\ninactive_file ${768 * MiB}\nkernel ${128 * MiB}\n`,
      ],
    ]);
    const memory = {
      env: {},
      cgroupMemoryLimitPaths: ["/test/memory.max"],
      physicalMemoryBytes: 16 * GiB,
      processResidentMemoryBytes: 64 * MiB,
      procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
      fs: createMemoryFileSystem(files),
    };
    const shared = resolveTsdownBuildPlan(memory);
    expect(shared.maxOldSpaceMb).toBe(3520);
    expect(shared.heapShortfall?.fatal).toBe(true);
    expect(readProcessMemoryCapacity(memory)).toMatchObject({
      capacityBytes: 5 * GiB,
      limitBytes: 4288 * MiB,
      usageKnown: true,
      unresolved: false,
    });
    files.set("/test/memory.current", `${832 * MiB}`);
    files.set(
      "/test/memory.stat",
      `anon ${64 * MiB}\nshmem 0\nfile ${768 * MiB}\ninactive_file ${768 * MiB}\nkernel 0\n`,
    );
    const isolated = resolveTsdownBuildPlan(memory);
    expect(isolated.maxOldSpaceMb).toBe(4352);
    expect(isolated.heapShortfall).toBeNull();
    expect(readProcessMemoryCapacity(memory)).toMatchObject({
      capacityBytes: 5 * GiB,
      limitBytes: 5 * GiB,
      usageKnown: true,
      unresolved: false,
    });
  });

  it("points Docker refusals at the public build heap override", () => {
    const shortfall = describeInsufficientTsdownHeap({
      env: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "" },
      cgroupMemoryLimitBytes: 4 * GiB,
    });
    expect(shortfall?.fatal).toBe(true);
    expect(shortfall?.message).toContain("set OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=<MB>");
    expect(shortfall?.message).not.toContain("set OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=<MB>");
  });

  it("refuses a fatal plan before cleanup and lets an explicit heap override proceed", () => {
    const cleanup = vi.fn();
    const reportShortfall = vi.fn();
    expect(
      prepareTsdownBuildExecution(
        { env: {}, cgroupMemoryLimitBytes: 4 * GiB },
        { cleanup, reportShortfall },
      ),
    ).toBeNull();
    expect(reportShortfall).toHaveBeenCalledWith(expect.objectContaining({ fatal: true }));
    expect(cleanup).not.toHaveBeenCalled();
    const plan = prepareTsdownBuildExecution(
      {
        cgroupMemoryLimitBytes: 4 * GiB,
        env: {
          OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4096",
          NODE_OPTIONS: "--trace-warnings --max-old-space-size=12288",
        },
      },
      { cleanup },
    );
    expect(plan).not.toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(plan?.heapShortfall?.fatal).toBe(false);
    expect(plan?.heapShortfall?.message).toContain(
      "Continuing because OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB explicitly requests 4096MB",
    );
    for (const invocation of plan?.invocations ?? []) {
      expect(invocation.options.env.NODE_OPTIONS).toBe(
        "--trace-warnings --max-old-space-size=4096",
      );
    }
  });

  it("caps finite cgroups by host MemAvailable and preserves zero", () => {
    const memory = {
      env: {},
      platform: "linux",
      cgroupMemoryLimitBytes: 8 * GiB,
      physicalMemoryBytes: 16 * GiB,
      procMeminfoPath: "/test/meminfo",
      fs: createMemoryFileSystem(
        new Map([["/test/meminfo", "MemTotal: 16777216 kB\nMemAvailable: 4194304 kB\n"]]),
      ),
    };
    expect(resolveTsdownBuildPlan(memory).maxOldSpaceMb).toBe(3328);
    expect(resolveTsdownBuildPlan({ ...memory, availableMemoryBytes: 0 }).maxOldSpaceMb).toBe(1);
    expect(readProcessMemoryCapacity(memory)).toMatchObject({
      capacityBytes: 8 * GiB,
      limitBytes: 4 * GiB,
      availableBytes: 4 * GiB,
    });
    expect(readProcessMemoryCapacity({ ...memory, availableMemoryBytes: 0 })).toMatchObject({
      capacityBytes: 8 * GiB,
      limitBytes: 0,
      availableBytes: 0,
    });
  });

  it("keeps raw capacity unknown without a physical bound", () => {
    expect(
      readProcessMemoryCapacity({
        platform: "linux",
        cgroupMemoryLimitBytes: 8 * GiB,
        physicalMemoryBytes: Number.NaN,
        availableMemoryBytes: 4 * GiB,
        fs: createMemoryFileSystem(new Map()),
      }),
    ).toMatchObject({
      capacityBytes: null,
      limitBytes: 4 * GiB,
      availableBytes: 4 * GiB,
      unresolved: false,
    });
  });

  const cgroupRoot = "/sys/fs/cgroup";
  const v2Mount = `30 25 0:26 / ${cgroupRoot} rw - cgroup2 cgroup2 rw\n`;
  const v1Mount = `31 25 0:27 / ${cgroupRoot} rw - cgroup cgroup rw,memory,cpu,cpuacct\n`;
  const hybridMounts = `30 25 0:26 /.. ${cgroupRoot}/unified rw - cgroup2 cgroup2 rw\n${v1Mount}`;
  const hybridRecord = "0::/\n2:memory,cpu,cpuacct:/parent/leaf\n";
  const v1Hierarchy: [string, string][] = [
    [`${cgroupRoot}/parent/memory.use_hierarchy`, "1"],
    [`${cgroupRoot}/memory.use_hierarchy`, "0"],
  ];
  const hostMeminfo = "MemTotal: 16777216 kB\nMemAvailable: 16777216 kB\n";
  function cgroupMemory(
    record: string,
    mounts: string,
    files: [string, string | Error][],
    params: TsdownInvocationParams = {},
  ): TsdownInvocationParams {
    return {
      platform: "linux",
      env: {},
      ...params,
      fs: createMemoryFileSystem(
        new Map([["/proc/self/cgroup", record], ["/proc/self/mountinfo", mounts], ...files]),
      ),
    };
  }

  const memoryCases: [
    name: string,
    memory: TsdownInvocationParams,
    heap: number,
    capacity?: number,
    admitted?: boolean,
    fatal?: boolean,
  ][] = [
    [
      "keeps a parsed zero-byte cgroup limit bounded",
      {
        cgroupMemoryLimitPaths: ["/test/memory.max"],
        fs: createMemoryFileSystem(new Map([["/test/memory.max", "0\n"]])),
      },
      1,
    ],
    [
      "uses Node's constrained-memory result as a canonical candidate",
      { constrainedMemoryBytes: 5 * GiB, cgroupMemoryLimitPaths: [] },
      4352,
    ],
    [
      "does not gate macOS builds on Node's instantaneous free-page count",
      {
        platform: "darwin",
        env: {},
        cgroupMemoryLimitPaths: [],
        constrainedMemoryBytes: 0,
        procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
        physicalMemoryBytes: 16 * GiB,
      },
      12288,
      undefined,
      true,
    ],
    [
      "caps an oversized cgroup limit by physical memory",
      {
        env: {},
        cgroupMemoryLimitBytes: 64 * GiB,
        procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
        physicalMemoryBytes: 4 * GiB,
      },
      3328,
      4 * GiB,
      undefined,
      true,
    ],
    [
      "uses the tightest finite cgroup ancestor even when the leaf is bounded",
      cgroupMemory("0::/parent/leaf\n", "", [
        [`${cgroupRoot}/parent/leaf/memory.max`, `${6 * GiB}`],
        [`${cgroupRoot}/parent/memory.high`, `${5 * GiB}`],
      ]),
      4352,
      5 * GiB,
    ],
    [
      "resolves a charged co-mounted v1 hierarchy behind an inherited v2 view",
      cgroupMemory(
        hybridRecord,
        hybridMounts,
        [
          ...v1Hierarchy,
          [`${cgroupRoot}/parent/memory.limit_in_bytes`, `${6 * GiB}`],
          [`${cgroupRoot}/parent/memory.usage_in_bytes`, `${1280 * MiB}`],
          [
            `${cgroupRoot}/parent/memory.stat`,
            `rss ${64 * MiB}\ntotal_rss ${512 * MiB}\ncache ${768 * MiB}\ntotal_inactive_file ${768 * MiB}\n`,
          ],
        ],
        { processResidentMemoryBytes: 64 * MiB },
      ),
      4928,
    ],
    [
      "uses host memory for unlimited hybrid v1 despite an advisory soft limit",
      cgroupMemory(
        hybridRecord,
        hybridMounts,
        [
          ...v1Hierarchy,
          [`${cgroupRoot}/parent/memory.limit_in_bytes`, "9223372036854771712"],
          [`${cgroupRoot}/parent/memory.soft_limit_in_bytes`, `${5 * GiB}`],
        ],
        {
          constrainedMemoryBytes: 5 * GiB,
          availableMemoryBytes: 16 * GiB,
          physicalMemoryBytes: 16 * GiB,
          procMemTotalBytes: 16 * GiB,
        },
      ),
      12288,
    ],
    [
      "uses host memory at an observed unconstrained v2 root",
      cgroupMemory("0::/\n", v2Mount, [["/proc/meminfo", hostMeminfo]]),
      12288,
      undefined,
      true,
    ],
    [
      "uses host memory when an observed v2 hierarchy disables memory",
      cgroupMemory("0::/parent/leaf\n", v2Mount, [
        ["/proc/meminfo", hostMeminfo],
        [`${cgroupRoot}/parent/leaf/cgroup.controllers`, "cpu io"],
      ]),
      12288,
      undefined,
      true,
    ],
    [
      "decodes both escaped mount roots and mount points before reading limits",
      cgroupMemory(
        "0::/user.slice/user 999.slice/openclaw.service\n",
        `30 25 0:26 /user.slice/user\\040999.slice ${cgroupRoot}\\040dir rw - cgroup2 cgroup2 rw\n`,
        [[`${cgroupRoot} dir/openclaw.service/memory.high`, `${5 * GiB}`]],
      ),
      4352,
    ],
    [
      "preserves process rlimits while ignoring v1 soft limits",
      cgroupMemory(
        "2:memory:/parent/leaf\n",
        v1Mount,
        [
          ...v1Hierarchy,
          [`${cgroupRoot}/parent/memory.limit_in_bytes`, "9223372036854771712"],
          [
            "/proc/self/limits",
            `Max data size            ${4 * GiB}        unlimited            bytes\nMax address space        ${6 * GiB}        unlimited            bytes\n`,
          ],
        ],
        { constrainedMemoryBytes: 5 * GiB, procMemTotalBytes: 16 * GiB },
      ),
      3328,
      4 * GiB,
    ],
    [
      "ignores a v1 parent limit when hierarchy accounting is disabled",
      cgroupMemory("2:memory:/parent/leaf\n", v1Mount, [
        [`${cgroupRoot}/parent/leaf/memory.limit_in_bytes`, `${8 * GiB}`],
        [`${cgroupRoot}/parent/memory.use_hierarchy`, "0"],
        [`${cgroupRoot}/parent/memory.limit_in_bytes`, `${4 * GiB}`],
      ]),
      7424,
    ],
    [
      "keeps a representable mount when a later view cannot represent the process",
      cgroupMemory(
        "0::/docker/abc123/openclaw.service\n",
        `30 25 0:26 /docker/abc123 ${cgroupRoot} rw - cgroup2 cgroup2 rw\n` +
          "31 25 0:26 /other/branch /mnt/peer-cgroup rw - cgroup2 cgroup2 rw\n",
        [
          [`${cgroupRoot}/openclaw.service/memory.max`, `${5 * GiB}`],
          ["/test/meminfo", "MemTotal: 7340032 kB\n"],
        ],
        { procMeminfoPath: "/test/meminfo" },
      ),
      4352,
    ],
  ];
  it.each(memoryCases)("%s", (_name, memory, heap, capacity, admitted, fatal) => {
    expect(resolveTestNodeOptions(memory)).toBe(`--max-old-space-size=${heap}`);
    if (capacity !== undefined) {
      expect(readProcessMemoryCapacity(memory).capacityBytes).toBe(capacity);
    }
    if (admitted || fatal !== undefined) {
      const plan = resolveTsdownBuildPlan(memory);
      expect(plan.maxOldSpaceMb).toBe(heap);
      if (admitted) {
        expect(plan.heapShortfall).toBeNull();
      } else {
        expect(plan.heapShortfall?.fatal).toBe(fatal);
      }
    }
  });

  function expectCgroupRefusal(memory: TsdownInvocationParams) {
    const plan = resolveTsdownBuildPlan(memory);
    expect(plan.maxOldSpaceMb).toBe(1);
    expect(plan.heapShortfall?.fatal).toBe(true);
    expect(plan.heapShortfall?.message).toContain(
      "process memory limit is not visible through this cgroup mount namespace",
    );
    const cleanup = vi.fn();
    expect(
      prepareTsdownBuildExecution({ ...memory, args: ["--config", "custom.ts"] }, { cleanup }),
    ).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
    return plan;
  }
  const unreadable = Object.assign(new Error("EACCES"), { code: "EACCES" });
  it.each([
    {
      name: "a cgroup record has no readable controller mount",
      memory: cgroupMemory("0::/hidden.slice/openclaw.service\n", "", [
        ["/proc/meminfo", "MemTotal: 16777216 kB\n"],
      ]),
    },
    {
      name: "Linux cgroup membership is unreadable",
      memory: {
        platform: "linux",
        env: {},
        fs: createMemoryFileSystem(
          new Map([
            ["/proc/self/mountinfo", v2Mount],
            ["/proc/meminfo", hostMeminfo],
            [`${cgroupRoot}/memory.max`, "max"],
            [`${cgroupRoot}/memory.high`, "max"],
          ]),
        ),
      },
    },
    {
      name: "an applicable limit is unreadable despite readable and disabled views",
      memory: cgroupMemory("0::/parent/leaf\n", v2Mount, [
        [`${cgroupRoot}/parent/leaf/memory.max`, `${8 * GiB}`],
        [`${cgroupRoot}/parent/leaf/memory.high`, unreadable],
        [`${cgroupRoot}/cgroup.controllers`, "cpu io"],
      ]),
    },
    {
      name: "a namespace-root record points at an unrelated mounted subtree",
      memory: cgroupMemory(
        "0::/\n",
        `30 25 0:26 /docker/2f1a9c ${cgroupRoot} rw - cgroup2 cgroup2 rw\n`,
        [[`${cgroupRoot}/memory.max`, `${5 * GiB}`]],
      ),
    },
    {
      name: "v1 hierarchy metadata is unreadable",
      memory: cgroupMemory("7:memory:/parent/leaf\n", v1Mount, [
        [`${cgroupRoot}/parent/leaf/memory.limit_in_bytes`, "9223372036854771712"],
        [`${cgroupRoot}/memory.use_hierarchy`, "0"],
        [`${cgroupRoot}/parent/memory.use_hierarchy`, unreadable],
        ["/proc/meminfo", hostMeminfo],
      ]),
    },
  ])("refuses cleanup when $name", ({ memory }) => {
    expectCgroupRefusal(memory);
  });

  it("refuses hidden inherited namespace limits unless the operator explicitly opts in", () => {
    const memory = cgroupMemory("0::/\n7:memory:/hidden.slice\n", hybridMounts, [
      [`${cgroupRoot}/memory.max`, "max"],
      ["/proc/meminfo", "MemTotal: 16777216 kB\n"],
    ]);
    expect(readProcessMemoryCapacity(memory)).toMatchObject({
      capacityBytes: null,
      limitBytes: null,
      availableBytes: null,
      unresolved: true,
    });
    const plan = expectCgroupRefusal(memory);
    expect(plan.heapShortfall?.message).toContain(
      "run the build where the process cgroup limit is visible",
    );
    const optedIn = resolveTsdownBuildPlan({
      ...memory,
      env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4096" },
    });
    expect(optedIn.maxOldSpaceMb).toBe(4096);
    expect(optedIn.heapShortfall?.fatal).toBe(false);
  });

  it("rejects parent segments without escaping the cgroup mount", () => {
    const pathsRead: string[] = [];
    const fsFixture = createMemoryFileSystem(
      new Map([
        ["/proc/self/cgroup", "0::/../peer.slice\n"],
        ["/proc/self/mountinfo", v2Mount],
        ["/proc/meminfo", "MemTotal: 7340032 kB\n"],
      ]),
      (filePath) => pathsRead.push(filePath),
    );
    expectCgroupRefusal({ env: {}, constrainedMemoryBytes: GiB, fs: fsFixture });
    expect(pathsRead.some((filePath) => filePath.includes("/sys/fs/peer.slice"))).toBe(false);
  });

  it("rejects malformed OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB values", () => {
    for (const value of ["0", "1.5", "9007199254740992"]) {
      expect(() =>
        resolveTsdownBuildInvocation({
          nodeExecPath: "/usr/bin/node",
          env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: value },
          ...NO_MEMORY_LIMIT,
        }),
      ).toThrow("OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB must be");
    }
  });

  it("limits cleanup to the explicitly selected declaration group", () => {
    expect(resolveTsdownCleanOutputRoots(["--config", "tsdown.ai.config.ts"])).toEqual([
      "packages/ai/dist",
    ]);
    expect(
      resolveTsdownCleanOutputRoots([
        "--config",
        "tsdown.config.ts",
        "--filter",
        "openclaw-packages",
      ]),
    ).toEqual(expect.arrayContaining(["packages/agent-core/dist", "packages/net-policy/dist"]));
    expect(
      resolveTsdownCleanOutputRoots(["--config=tsdown.config.ts", "--filter=openclaw-packages"]),
    ).not.toContain("packages/ai/dist");
    expect(resolveTsdownCleanOutputRoots(["-c=tsdown.config.ts", "-F=openclaw-unified"])).toEqual([
      "dist",
      "dist-runtime",
    ]);
    expect(
      resolveTsdownCleanOutputRoots([
        "-c=tsdown.config.ts",
        `-F=${TSDOWN_UNIFIED_DTS_CONFIG_GROUPS[0]}`,
      ]),
    ).toEqual(["dist", "dist-runtime"]);
    expect(
      resolveTsdownCleanOutputRoots([
        "--config",
        "configs/tsdown.config.ts",
        "--filter",
        "openclaw-packages",
      ]),
    ).toEqual(listTsdownOutputRoots());
    expect(resolveTsdownCleanOutputRoots(["--format", "esm"])).toEqual(listTsdownOutputRoots());
  });

  it("prunes hashed root chunks while preserving stable aliases and nested assets", () =>
    fixture.run(async () => {
      const root = createTempDir("tsdown-chunks-");
      const retained = [
        "dist/compact.runtime.js",
        "dist/entry.js",
        "dist/control-ui/index.html",
        "dist-runtime/heartbeat-runner.runtime.js",
      ];
      const removed = [
        "dist/delegate-BPjCe4gC.js",
        "dist/compact.runtime-2DiEmVcA.js",
        "dist-runtime/heartbeat-runner.runtime-fspOEj_1.js",
      ];
      for (const file of [...retained, ...removed]) {
        writeFixtureFile(root, file, file);
      }
      pruneStaleRootChunkFiles({ cwd: root });
      for (const file of retained) {
        expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(file);
      }
      for (const file of removed) {
        expectPathMissing(path.join(root, file));
      }
    }));

  it.each([
    { label: "default build", args: [], skipDts: "0", preserveMetadata: "0" },
    { label: "cached source launcher", args: ["--no-clean"], skipDts: "1", preserveMetadata: "1" },
  ])(
    "preserves separately owned outputs during $label cleanup",
    ({ args, skipDts, preserveMetadata }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-clean-");
        const sourceDependencies = await createSourcePluginDependenciesFixture(rootDir);
        sourceDependencies.assertResolution();
        const retainedFiles = [
          "dist/control-ui/index.html",
          "dist/control-ui/assets/nested/styles-AbCd1234.css",
          `dist/control-ui.build-${process.pid}-fixture/assets/lazy.js`,
          `dist/control-ui.build-${process.pid}-fixture.retired/index.html`,
          "packages/plugin-sdk/dist/keep.js",
          "packages/agent-core/src/keep.ts",
          "tmp/keep.js",
        ];
        const declarationFiles = [
          "dist/plugin-sdk/core.d.ts",
          "dist/plugin-sdk/nested/types.d.cts",
          "packages/media-understanding-common/dist/index.d.mts",
          "packages/media-understanding-common/dist/nested/types.d.ts",
        ];
        const metadataFile = "dist/cli-startup-metadata.json";
        const staleFiles = [
          "dist/entry.js",
          "dist/stale-AbCd1234.js",
          "dist/plugin-sdk/core.js",
          "dist/nested/stale.js",
          "dist/control-ui-old/index.html",
          "dist/extensions/demo/src/index.js",
          "dist/extensions/demo/node_modules/staged/index.js",
          "dist/extensions/node_modules/openclaw/plugin-sdk/core.js",
          "dist-runtime/stale.js",
          "dist-runtime/control-ui/index.html",
          "dist-runtime/extensions/demo/index.js",
          "dist-runtime/extensions/demo/index.d.ts",
          "dist-runtime/extensions/demo/node_modules/staged/index.js",
          "packages/agent-core/dist/stale.js",
          "packages/net-policy/dist/stale.js",
          "packages/media-understanding-common/dist/index.mjs",
          "packages/media-understanding-common/dist/chunks/old.js",
        ];
        for (const relativePath of [
          ...retainedFiles,
          ...declarationFiles,
          metadataFile,
          ...staleFiles,
        ]) {
          writeFixtureFile(rootDir, relativePath, `sentinel:${relativePath}\n`);
        }

        const scriptUrl = pathToFileURL(path.resolve("scripts/tsdown-build.mts")).href;
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            "--input-type=module",
            "-e",
            `import { prepareTsdownBuildExecution } from ${JSON.stringify(scriptUrl)};
       const plan = prepareTsdownBuildExecution(${JSON.stringify({ args, ...NO_MEMORY_LIMIT })});
       if (!plan) throw new Error("fixture build was not admitted");`,
          ],
          {
            cwd: rootDir,
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: skipDts,
              OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: preserveMetadata,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        sourceDependencies.assertResolution();
        for (const relativePath of staleFiles) {
          expectPathMissing(path.join(rootDir, relativePath));
        }
        for (const relativePath of [
          "dist/extensions/demo/node_modules",
          "dist/extensions/node_modules",
          "dist-runtime/extensions/demo/node_modules",
          "packages/agent-core/dist",
          "packages/net-policy/dist",
        ]) {
          expectPathMissing(path.join(rootDir, relativePath));
        }
        for (const [files, preserve] of [
          [declarationFiles, skipDts === "1"],
          [[metadataFile], preserveMetadata === "1"],
        ] as const) {
          for (const relativePath of files) {
            if (preserve) {
              retainedFiles.push(relativePath);
            } else {
              expectPathMissing(path.join(rootDir, relativePath));
            }
          }
        }
        for (const relativePath of retainedFiles) {
          expect(fs.readFileSync(path.join(rootDir, relativePath), "utf8")).toBe(
            `sentinel:${relativePath}\n`,
          );
        }
      }),
  );

  it.each([
    { label: "direct root", link: "packages/ai/dist", declaration: "index.d.ts" },
    { label: "intermediate root", link: "packages", declaration: "ai/dist/index.d.ts" },
  ])("refuses to sanitize a symlinked $label", ({ link, declaration }) =>
    fixture.run(async () => {
      const root = createTempDir("tsdown-sanitize-link-");
      const target = path.join(root, "target");
      const malformed = "export { __exportAll, publicApi };\n";
      const file = writeFixtureFile(target, declaration, malformed);
      fs.mkdirSync(path.dirname(path.join(root, link)), { recursive: true });
      fs.symlinkSync(target, path.join(root, link), "dir");
      expect(() =>
        sanitizeTsdownBuildOutputRoots(["--config", "tsdown.ai.config.ts"], root),
      ).toThrow(/symbolic link/u);
      expect(fs.readFileSync(file, "utf8")).toBe(malformed);
    }),
  );

  it.each([
    { code: 0, expectedAi: "export { publicApi };\n", label: "successful" },
    { code: 1, expectedAi: "export { __exportAll, publicApi };\n", label: "failed" },
  ])("sanitizes selected declarations only after a $label direct build", ({ code, expectedAi }) =>
    fixture.run(async () => {
      const rootDir = createTempDir(`openclaw-tsdown-runner-sanitize-${code}-`);
      const malformed = "export { __exportAll, publicApi };\n";
      const aiDeclaration = writeFixtureFile(rootDir, "packages/ai/dist/index.d.ts", malformed);
      const rootDeclaration = writeFixtureFile(rootDir, "dist/index.d.ts", malformed);
      const executeBuild = vi.fn(async () => code);

      await expect(
        runTsdownBuild(["--config", "tsdown.ai.config.ts"], { cwd: rootDir, executeBuild }),
      ).resolves.toBe(code);

      expect(executeBuild).toHaveBeenCalledWith(["--config", "tsdown.ai.config.ts"]);
      expect(fs.readFileSync(aiDeclaration, "utf8")).toBe(expectedAi);
      expect(fs.readFileSync(rootDeclaration, "utf8")).toBe(malformed);
    }),
  );

  it("refuses a direct tsdown entry before executeBuild when the live Gateway fence trips", () =>
    fixture.run(async () => {
      const executeBuild = vi.fn(async () => 0);
      const resolveLiveGatewayDistFence = vi
        .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
        .mockResolvedValue({
          refuse: true,
          message: "[openclaw] Refusing to rebuild dist while a managed Gateway is still running.",
        });

      await expect(
        runTsdownBuild(["--config", "tsdown.ai.config.ts"], {
          cwd: createTempDir("openclaw-tsdown-live-fence-"),
          executeBuild,
        }),
      ).resolves.toBe(1);

      expect(executeBuild).not.toHaveBeenCalled();
      expect(resolveLiveGatewayDistFence).toHaveBeenCalledOnce();
    }));

  it("keeps a nested packaged Mac app intact while replacing runtime output", () =>
    fixture.run(async () => {
      const root = createTempDir("tsdown-app-");
      const app = writeFixtureFile(
        root,
        "dist/candidates/OpenClaw.app/Contents/Resources/worker.js",
        "signed worker",
      );
      const stale = writeFixtureFile(root, "dist/stale.js", "stale");
      cleanTsdownOutputRoots({ cwd: root, roots: ["dist"] });
      expect(fs.readFileSync(app, "utf8")).toBe("signed worker");
      expectPathMissing(stale);
    }));

  it("cleans only an absolute selected output without rebasing it under cwd", () =>
    fixture.run(async () => {
      const root = createTempDir("tsdown-absolute-clean-");
      const output = path.join(root, "custom-dist");
      writeFixtureFile(output, "stale.js", "stale");
      const cwd = path.join(root, "checkout");
      const keep = writeFixtureFile(cwd, "dist/keep.js", "keep");
      cleanTsdownOutputRoots({ cwd, roots: [output] });
      expectPathMissing(output);
      expect(fs.readFileSync(keep, "utf8")).toBe("keep");
    }));

  it("refuses an output root containing checkout artifact ownership from a nested cwd", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-owner-clean-");
      const cwd = path.join(rootDir, "src");
      const owner = path.join(rootDir, ".artifacts/dist-artifacts.lock/owner.json");
      fs.mkdirSync(path.dirname(owner), { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(path.join(rootDir, ".git"));
      fs.writeFileSync(owner, "owned");
      expect(() =>
        cleanTsdownOutputRoots({ cwd, roots: [path.join(rootDir, ".artifacts")] }),
      ).toThrow("Cannot clean the checkout's dist artifact ownership location");
      expect(fs.readFileSync(owner, "utf8")).toBe("owned");
    }));

  it.each([".", ".."])('refuses to clean cwd or ancestor "%s"', (output) =>
    fixture.run(async () => {
      const root = createTempDir("tsdown-cwd-clean-");
      const cwd = path.join(root, "checkout");
      const keep = writeFixtureFile(cwd, "keep.js", "keep");
      expect(() => cleanTsdownOutputRoots({ cwd, roots: [output] })).toThrow(
        "Cannot clean the current working directory or one of its ancestors",
      );
      expect(fs.readFileSync(keep, "utf8")).toBe("keep");
    }),
  );

  it("refuses to clean a Windows UNC share root", () => {
    const outputRoot = "\\\\server\\share\\";
    const rmSync = vi.spyOn(fs, "rmSync");
    try {
      expect(() =>
        cleanTsdownOutputRoots({
          cwd: "C:\\openclaw",
          pathImpl: path.win32,
          roots: [outputRoot],
        }),
      ).toThrow("Cannot clean a filesystem root");
      expect(rmSync).not.toHaveBeenCalled();
    } finally {
      rmSync.mockRestore();
    }
  });

  it("validates every clean root before traversing protected children or mutating output", () =>
    fixture.run(async () => {
      const root = createTempDir("tsdown-clean-roots-");
      const first = writeFixtureFile(root, "dist/keep.js", "keep");
      const target = path.join(root, "gateway-runtime");
      const file = writeFixtureFile(target, "chunk-abc123.js", "generated");
      const metadata = writeFixtureFile(target, "cli-startup-metadata.json", "metadata");
      const link = path.join(root, "dist-runtime");
      fs.symlinkSync(target, link, "dir");
      const reads = vi.spyOn(fs, "readdirSync");
      try {
        expect(() =>
          cleanTsdownOutputRoots({
            cwd: root,
            roots: ["dist", "dist-runtime"],
            env: {
              OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
              OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
            },
          }),
        ).toThrow(/symbolic link/u);
        expect(reads).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
      }
      expect(fs.readlinkSync(link)).toBe(target);
      expect(fs.readFileSync(first, "utf8")).toBe("keep");
      expect(fs.readFileSync(file, "utf8")).toBe("generated");
      expect(fs.readFileSync(metadata, "utf8")).toBe("metadata");
    }));

  it("refuses an output root behind an intermediate symlink", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-clean-parent-symlink-");
      const checkoutDir = path.join(rootDir, "checkout");
      const targetDir = path.join(rootDir, "external", "dist");
      const targetFile = path.join(targetDir, "keep.js");
      fs.mkdirSync(checkoutDir);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetFile, "keep\n");
      fs.symlinkSync(path.dirname(targetDir), path.join(checkoutDir, "linked"), "dir");

      expect(() =>
        cleanTsdownOutputRoots({ cwd: checkoutDir, roots: [path.join("linked", "dist")] }),
      ).toThrow(/symbolic link/u);

      expect(fs.readFileSync(targetFile, "utf8")).toBe("keep\n");
    }));

  it("validates every chunk root before pruning any output", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-prune-roots-");
      const firstRootFile = path.join(rootDir, "dist", "delegate-OldHash.js");
      const targetDir = path.join(rootDir, "gateway-runtime");
      fs.mkdirSync(path.dirname(firstRootFile), { recursive: true });
      fs.mkdirSync(targetDir);
      fs.writeFileSync(firstRootFile, "keep\n");
      fs.symlinkSync(targetDir, path.join(rootDir, "dist-runtime"), "dir");

      expect(() => pruneStaleRootChunkFiles({ cwd: rootDir })).toThrow(/symbolic link/u);

      expect(fs.readFileSync(firstRootFile, "utf8")).toBe("keep\n");
    }));

  it("refuses to prune runtime overlay symlinks through a symlinked output root", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-runtime-symlink-");
      const targetDir = path.join(rootDir, "gateway-dist");
      const pluginNodeModules = path.join(targetDir, "extensions", "telegram", "node_modules");
      fs.mkdirSync(pluginNodeModules, { recursive: true });
      const markerFile = path.join(pluginNodeModules, "keep.js");
      fs.writeFileSync(markerFile, "keep\n");
      const distLink = path.join(rootDir, "dist");
      fs.symlinkSync(targetDir, distLink, "dir");

      expect(() => pruneStaleRuntimeSymlinks({ cwd: rootDir })).toThrow(/symbolic link/u);

      expect(fs.readlinkSync(distLink)).toBe(targetDir);
      expect(fs.readFileSync(markerFile, "utf8")).toBe("keep\n");
    }));

  it("prunes untracked generated declaration files that shadow source entries", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-source-dts-");
      const signalDir = path.join(rootDir, "extensions", "signal");
      const signalSrcDir = path.join(signalDir, "src");
      fs.mkdirSync(signalSrcDir, { recursive: true });
      fs.writeFileSync(path.join(signalDir, "api.ts"), "export {};\n");
      fs.writeFileSync(path.join(signalDir, "api.d.ts"), "export {};\n");
      fs.writeFileSync(path.join(signalSrcDir, "probe.ts"), "export {};\n");
      fs.writeFileSync(path.join(signalSrcDir, "probe.d.ts"), "export {};\n");
      fs.writeFileSync(path.join(signalSrcDir, "ambient.d.ts"), "declare const x: string;\n");

      const removed = pruneUntrackedGeneratedSourceDeclarations({
        cwd: rootDir,
        spawnSync: () => ({
          status: 0,
          stdout:
            "extensions/signal/api.d.ts\nextensions/signal/src/probe.d.ts\nextensions/signal/src/ambient.d.ts\n",
        }),
      });

      expect(removed).toBe(2);
      expectPathMissing(path.join(signalDir, "api.d.ts"));
      expectPathMissing(path.join(signalSrcDir, "probe.d.ts"));
      expect(fs.readFileSync(path.join(signalSrcDir, "ambient.d.ts"), "utf8")).toBe(
        "declare const x: string;\n",
      );
    }));
});

describe("runTsdownBuildInvocation", () => {
  function createWriteSink() {
    const chunks: string[] = [];
    return {
      sink: {
        write(chunk: unknown) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
          return true;
        },
      },
      chunks,
    };
  }

  function nodeInvocation(script: string, env: NodeJS.ProcessEnv = process.env) {
    return {
      command: process.execPath,
      args: ["-e", script],
      options: { stdio: ["ignore", "pipe", "pipe"], shell: false, env },
    };
  }

  function startTimeoutFixture(
    parentScript: string,
    output: ReturnType<typeof createWriteSink>,
    signal: AbortSignal,
  ) {
    const schedule = globalThis.setTimeout;
    const cancel = globalThis.clearTimeout;
    let now = Date.now();
    const clock = vi.spyOn(Date, "now");
    let abortFailure: Error | undefined;
    const pending = new Map<ReturnType<typeof setTimeout>, { at: number; fire: () => void }>();
    // Only the watchdog and escalation use 250ms. Group polling stays real, but
    // its Date.now deadline shares this logical clock with both callbacks.
    const timers = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, ms, ...args) => {
        if (ms !== 250) {
          return schedule(callback, ms, ...args);
        }
        const handle = schedule(() => {}, ms);
        pending.set(handle, { at: now + ms, fire: () => callback(...args) });
        return handle;
      });
    const clears = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
      if (typeof handle === "object" && handle) {
        pending.delete(handle);
      }
      cancel(handle);
    });
    const completion = runTsdownBuildInvocation(nodeInvocation(parentScript), {
      stdout: output.sink,
      stderr: output.sink,
      env: {
        ...process.env,
        OPENCLAW_TSDOWN_HEARTBEAT_MS: "0",
        OPENCLAW_TSDOWN_TIMEOUT_MS: "250",
      },
    });
    const supervisor = {
      completion,
      advance(ms: number) {
        const target = now + ms;
        while (true) {
          const next = [...pending].toSorted((left, right) => left[1].at - right[1].at)[0];
          if (!next || next[1].at > target) {
            break;
          }
          now = next[1].at;
          clock.mockReturnValue(now);
          pending.delete(next[0]);
          cancel(next[0]);
          next[1].fire();
        }
        now = target;
        clock.mockReturnValue(now);
      },
      resume() {
        const started = performance.now();
        clock.mockImplementation(() => now + performance.now() - started);
      },
      dispose(pid?: number) {
        return fixture.verifyCleanup(async () => {
          try {
            try {
              supervisor.advance(500);
            } finally {
              supervisor.resume();
            }
          } finally {
            try {
              await completion;
              if (pid !== undefined && isProcessAlive(pid)) {
                process.kill(pid, "SIGKILL");
                await waitForForeignProcessExit(pid, signal);
              }
            } finally {
              signal.removeEventListener("abort", abort);
              for (const handle of pending.keys()) {
                cancel(handle);
              }
              clears.mockRestore();
              timers.mockRestore();
              clock.mockRestore();
            }
          }
          if (abortFailure) {
            throw abortFailure;
          }
        });
      },
    };
    const abort = () => {
      try {
        try {
          supervisor.advance(500);
        } finally {
          supervisor.resume();
        }
      } catch (error) {
        // Event listeners cannot reject the driver promise. Report the failure
        // from restoration after the caller has awaited the owned completion.
        abortFailure = new Error("Controlled supervisor cancellation failed", { cause: error });
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    return supervisor;
  }

  it("recognizes ineffective dynamic imports split across output chunks", () => {
    const marker = "[INEFFECTIVE_DYNAMIC_IMPORT]";
    const output = `${marker} synthetic.ts\n`;
    for (let split = 1; split < marker.length; split += 1) {
      const scanner = createTsdownOutputScanner({ maxCaptureBytes: 7 });
      scanner.append(Buffer.from(output.slice(0, split)));
      scanner.append(Buffer.from(output.slice(split)));
      expect(scanner.finish(), `split at ${split}`).toMatchObject({
        captured: output.slice(-7),
        hasIneffectiveDynamicImport: true,
      });
    }
  });

  it("streams output while bounding capture and classifying build diagnostics", () =>
    fixture.run(async () => {
      const output = createWriteSink();
      const lines = [
        "stdout-ok prefix that will be trimmed",
        "[UNRESOLVED_IMPORT] extensions/telegram/src/index.ts",
        "[UNRESOLVED_IMPORT] node_modules/example/index.js",
        "[UNRESOLVED_IMPORT] ../../../../tmp/openclaw-pnpm-node-modules/baileys/lib/Utils/messages-media.js",
        "[UNRESOLVED_IMPORT] src/index.ts",
      ];
      const result = await runTsdownBuildInvocation(
        nodeInvocation(
          `process.stdout.write(${JSON.stringify(lines.join("\n") + "\n")}); process.stderr.write('[INEFFECTIVE_DYNAMIC_IMPORT]')`,
        ),
        {
          stdout: output.sink,
          stderr: output.sink,
          scanner: createTsdownOutputScanner({ maxCaptureBytes: 20 }),
          env: { OPENCLAW_TSDOWN_HEARTBEAT_MS: "0" },
        },
      );
      expect(result.status).toBe(0);
      expect(result.hasIneffectiveDynamicImport).toBe(true);
      expect(result.fatalUnresolvedImport).toBe("[UNRESOLVED_IMPORT] src/index.ts");
      expect(result.captured.length).toBeLessThanOrEqual(20);
      expect(output.chunks.join("")).toContain("stdout-ok");
      expect(output.chunks.join("")).not.toContain("[tsdown-build] child result");
    }));

  it("reports a silent compiler failure without attributing it to cleanup", () =>
    fixture.run(async () => {
      const output = createWriteSink();
      const result = await runTsdownBuildInvocation(nodeInvocation("process.exit(7)"), {
        stderr: output.sink,
        env: { OPENCLAW_TSDOWN_HEARTBEAT_MS: "0" },
      });

      expect(result).toMatchObject({ status: 7, signal: null, timedOut: false, error: null });
      expect(output.chunks.join("")).toContain(
        JSON.stringify({
          status: 7,
          signal: null,
          parentSignal: null,
          timedOut: false,
          cleanup: "none",
          observedProcessState: "dead",
          observationScope: process.platform === "win32" ? "leader" : "process-group",
          finalStatus: 7,
        }),
      );
    }));

  it.skipIf(process.platform === "win32")(
    "reports cleanup rejecting a successful compiler with a remaining descendant",
    ({ signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-close-");
        const childPidPath = path.join(rootDir, "child.pid");
        const childScript = receiptFixtureScript([
          `require('node:fs').writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          `sendReceipt(${JSON.stringify(childPidPath)}, "ready");`,
          "setInterval(() => {}, 1000);",
          "process.send('ready');",
        ]);
        const parentScript = [
          `const child = require('node:child_process').spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
          // Readiness owns the race: the compiler exits only once its same-group
          // descendant is running, without that descendant holding output pipes.
          "child.once('message', () => { child.disconnect(); child.unref(); process.exit(0); });",
        ].join("");
        const output = createWriteSink();
        const completion = runTsdownBuildInvocation(nodeInvocation(parentScript), {
          stderr: output.sink,
          env: { OPENCLAW_TSDOWN_HEARTBEAT_MS: "0", OPENCLAW_TSDOWN_TIMEOUT_MS: "5000" },
        });
        let childPid: number | undefined;
        try {
          await fixtureEventBeforeSettlement(childPidPath, "", completion, signal);
          childPid = Number(fs.readFileSync(childPidPath, "utf8"));
          expect(await withinTest(completion, signal)).toMatchObject({
            status: 1,
            signal: null,
            timedOut: false,
            error: null,
          });
          expect(output.chunks.join("")).toContain(
            JSON.stringify({
              status: 0,
              signal: null,
              parentSignal: null,
              timedOut: false,
              cleanup: "remaining-descendants",
              observedProcessState: "dead",
              observationScope: "process-group",
              finalStatus: 1,
            }),
          );
          expect(isProcessAlive(childPid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            try {
              await completion;
            } finally {
              childPid ??= fs.existsSync(childPidPath)
                ? Number(fs.readFileSync(childPidPath, "utf8"))
                : undefined;
              if (childPid !== undefined && isProcessAlive(childPid)) {
                process.kill(childPid, "SIGKILL");
                await waitForForeignProcessExit(childPid, signal);
              }
            }
          });
        }
      }),
  );

  it("preserves successful native declarations when source syntax is invalid", ({ signal }) =>
    fixture.run(async () => {
      const rootDir = fs.realpathSync(createTempDir("openclaw-tsdown-syntax-"));
      const sourcePath = path.join(rootDir, "index.ts");
      const outputPath = path.join(rootDir, "dist", "index.d.ts");
      fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}\n');
      fs.writeFileSync(
        path.join(rootDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            declaration: true,
            emitDeclarationOnly: true,
            noCheck: true,
            noEmitOnError: false,
            rootDir,
          },
          files: [sourcePath],
        }),
      );
      const buildOptions = {
        clean: false,
        config: false,
        cwd: rootDir,
        entry: [sourcePath],
        fixedExtension: false,
        format: "esm",
        logLevel: "error",
        outDir: path.join(rootDir, "dist"),
        platform: "node",
        report: false,
        tsconfig: path.join(rootDir, "tsconfig.json"),
      };
      const dtsOptions = '{ generator: "tsgo", emitDtsOnly: true, tsgo: { path: getExePath() } }';
      const script = [
        'import { build } from "tsdown";',
        'const nativePackage = import.meta.resolve("typescript/package.json");',
        'const { default: getExePath } = await import(new URL("lib/getExePath.js", nativePackage).href);',
        `await build({ ...${JSON.stringify(buildOptions)}, dts: ${dtsOptions} });`,
      ].join("\n");
      const output = createWriteSink();
      // Keep compiler scratch output inside the fixture even when compilation rejects.
      const env = { ...process.env, TMPDIR: rootDir, TEMP: rootDir, TMP: rootDir };
      const invocation = {
        command: process.execPath,
        args: ["--input-type=module", "-e", script],
        options: { stdio: ["ignore", "pipe", "pipe"], shell: false, env },
      };
      const runOptions = { stdout: output.sink, stderr: output.sink };

      fs.writeFileSync(sourcePath, 'export const broken = "healthy";\n');
      const healthy = await runTsdownBuildInvocation(invocation, runOptions);
      expect(healthy.status, healthy.captured).toBe(0);
      const previous = fs.readFileSync(outputPath, "utf8");
      expect(previous).toContain('"healthy"');

      signal.throwIfAborted();
      fs.writeFileSync(sourcePath, "export const broken = ;\n");
      const failed = await runTsdownBuildInvocation(invocation, runOptions);
      expect(failed).toMatchObject({ error: null, signal: null, timedOut: false });
      expect(failed.status, failed.captured).toBeGreaterThan(0);
      expect(fs.readFileSync(outputPath, "utf8")).toBe(previous);
      expect(failed.captured).toContain("TS1109");
    }));

  it("rejects a non-integer heartbeat before spawning", () =>
    fixture.run(async () => {
      await expect(
        runTsdownBuildInvocation(nodeInvocation("process.exit(0)"), {
          env: { ...process.env, OPENCLAW_TSDOWN_HEARTBEAT_MS: "1.5" },
        }),
      ).rejects.toThrow("OPENCLAW_TSDOWN_HEARTBEAT_MS must be");
    }));

  it.skipIf(process.platform === "win32")(
    "kills timed-out tsdown process groups when the wrapper exits first",
    ({ signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-timeout-");
        const childPidPath = path.join(rootDir, "child.pid");
        const parentPidPath = path.join(rootDir, "parent.pid");
        const termPath = path.join(rootDir, "child.term");
        // Allocate the marker before readiness; filesystem setup must not consume termination grace.
        const childScript = receiptFixtureScript([
          "const fs = require('node:fs');",
          `const termFd = fs.openSync(${JSON.stringify(termPath)}, 'wx');`,
          `process.on('SIGTERM', () => { fs.writeSync(termFd, 'SIGTERM', 0); sendReceipt(${JSON.stringify(termPath)}, "SIGTERM"); });`,
          `fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.ppid));`,
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          `sendReceipt(${JSON.stringify(childPidPath)}, "ready");`,
          "setInterval(() => {}, 1000);",
        ]);
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "process.on('SIGTERM', () => process.exit(0));",
          `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const output = createWriteSink();
        const supervisor = startTimeoutFixture(parentScript, output, signal);
        let childPid: number | undefined;

        try {
          // The descendant publishes its PID only after installing its SIGTERM handler.
          await fixtureEventBeforeSettlement(childPidPath, "", supervisor.completion, signal);
          childPid = Number(fs.readFileSync(childPidPath, "utf8"));
          expect(isProcessAlive(childPid)).toBe(true);
          supervisor.advance(250);
          await fixtureEventBeforeSettlement(termPath, "SIGTERM", supervisor.completion, signal);
          const parentPid = Number(fs.readFileSync(parentPidPath, "utf8"));
          await waitForForeignProcessExit(parentPid, signal);
          supervisor.advance(249);
          expect(isProcessAlive(childPid)).toBe(true);
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          supervisor.advance(1);
          supervisor.resume();
          const result = await withinTest(supervisor.completion, signal);

          expect(result).toMatchObject({ timedOut: true, status: 0, signal: null, error: null });
          expect(fs.readFileSync(termPath, "utf8")).toBe("SIGTERM");
          expect(output.chunks.join("")).toContain("timeout after 250ms");
          expect(output.chunks.join("")).toContain('"cleanup":"timeout"');
          expect(output.chunks.join("")).toContain("forcing SIGKILL");
          expect(isProcessAlive(childPid)).toBe(false);
        } finally {
          await supervisor.dispose(childPid);
        }
      }),
  );

  it.skipIf(process.platform === "win32")(
    "preserves timeout grace when descendant processes exit cleanly",
    ({ signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-timeout-clean-");
        const cleanupPath = path.join(rootDir, "child.cleanup");
        const termPath = path.join(rootDir, "child.term");
        const releasePath = path.join(rootDir, "child.release");
        const childPidPath = path.join(rootDir, "child.pid");
        const parentPidPath = path.join(rootDir, "parent.pid");
        // Allocate markers before readiness; their contents record signal and released cleanup.
        const childScript = receiptFixtureScript([
          "const fs = require('node:fs');",
          `const termFd = fs.openSync(${JSON.stringify(termPath)}, 'wx');`,
          `const cleanupFd = fs.openSync(${JSON.stringify(cleanupPath)}, 'wx');`,
          "process.on('SIGTERM', () => {",
          "  fs.writeSync(termFd, 'SIGTERM', 0);",
          `  const release = fs.watch(${JSON.stringify(rootDir)}, () => {`,
          `    if (!fs.existsSync(${JSON.stringify(releasePath)})) return;`,
          "    release.close();",
          "    fs.writeSync(cleanupFd, 'clean', 0);",
          "    process.exit(0);",
          "  });",
          // Install the release observer before acknowledging TERM, so the test's
          // subsequent file creation cannot outrun watcher registration.
          `  sendReceipt(${JSON.stringify(termPath)}, "SIGTERM");`,
          "});",
          `fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.ppid));`,
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          `sendReceipt(${JSON.stringify(childPidPath)}, "ready");`,
          "setInterval(() => {}, 1000);",
        ]);
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "process.on('SIGTERM', () => process.exit(0));",
          `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const output = createWriteSink();
        const supervisor = startTimeoutFixture(parentScript, output, signal);
        let childPid: number | undefined;

        try {
          // The descendant publishes its PID only after installing its SIGTERM handler.
          await fixtureEventBeforeSettlement(childPidPath, "", supervisor.completion, signal);
          childPid = Number(fs.readFileSync(childPidPath, "utf8"));
          supervisor.advance(250);
          await fixtureEventBeforeSettlement(termPath, "SIGTERM", supervisor.completion, signal);
          const parentPid = Number(fs.readFileSync(parentPidPath, "utf8"));
          await waitForForeignProcessExit(parentPid, signal);
          supervisor.advance(249);
          expect(isProcessAlive(childPid)).toBe(true);
          expect(fs.readFileSync(cleanupPath, "utf8")).toBe("");
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          fs.writeFileSync(releasePath, "release");
          const result = await withinTest(supervisor.completion, signal);

          expect(result).toMatchObject({ timedOut: true, status: 0, signal: null, error: null });
          expect(fs.readFileSync(cleanupPath, "utf8")).toBe("clean");
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          // Even a late escalation callback must be inert after the real join.
          supervisor.advance(1);
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          supervisor.resume();
          expect(isProcessAlive(childPid)).toBe(false);
        } finally {
          await supervisor.dispose(childPid);
        }
      }),
  );

  it.skipIf(process.platform === "win32")(
    "cleans process-group descendants before forwarding parent SIGTERM",
    ({ signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-parent-signal-");
        const childPidPath = path.join(rootDir, "child.pid");
        const readyPath = path.join(rootDir, "child.ready");
        const scriptUrl = pathToFileURL(path.resolve("scripts/tsdown-build.mts")).href;
        let childPid = 0;
        let runner: ReturnType<typeof spawn> | undefined;
        let runnerClosed: Promise<unknown[]> | undefined;

        try {
          const childScript = receiptFixtureScript([
            "const fs = require('node:fs');",
            "process.on('SIGTERM', () => {});",
            `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
            `sendReceipt(${JSON.stringify(childPidPath)}, "ready");`,
            "setInterval(() => {}, 1000);",
          ]);
          const parentScript = receiptFixtureScript([
            "const { spawn } = require('node:child_process');",
            `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
            `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
            `sendReceipt(${JSON.stringify(readyPath)}, "ready");`,
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => {}, 1000);",
          ]);
          const runnerScript = [
            `import { runTsdownBuildInvocation } from ${JSON.stringify(scriptUrl)};`,
            "const result = await runTsdownBuildInvocation(",
            `  { command: process.execPath, args: ['--input-type=module', '-e', ${JSON.stringify(parentScript)}], options: { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env } },`,
            "  { env: { ...process.env, OPENCLAW_TSDOWN_HEARTBEAT_MS: '0' } },",
            "); process.exitCode = result.status ?? 1;",
          ].join("\n");

          runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
            cwd: process.cwd(),
            stdio: ["ignore", "ignore", "pipe"],
          });

          runnerClosed = fixture.track(once(runner, "close"));
          await fixtureEventBeforeSettlement(readyPath, "ready", runnerClosed, signal);
          await fixtureEventBeforeSettlement(childPidPath, "", runnerClosed, signal);
          childPid = Number(fs.readFileSync(childPidPath, "utf8"));
          expect(isProcessAlive(childPid)).toBe(true);

          runner.kill("SIGTERM");

          await expect(withinTest(runnerClosed, signal)).resolves.toEqual([143, null]);
          expect(isProcessAlive(childPid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            if (runner?.pid && isProcessAlive(runner.pid)) {
              runner.kill("SIGTERM");
            }
            await runnerClosed;
            if (childPid && isProcessAlive(childPid)) {
              process.kill(childPid, "SIGKILL");
              await waitForForeignProcessExit(childPid, signal);
            }
          });
        }
      }),
  );
});
