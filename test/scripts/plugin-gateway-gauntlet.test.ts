import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
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
import * as runner from "../../scripts/check-plugin-gateway-gauntlet.mts";
import * as gauntlet from "../../scripts/lib/plugin-gateway-gauntlet.mts";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

const tsxImport = import.meta.resolve("tsx");
const testNodeExecPath = resolveTestNodeExecPath();
const dryRunArgs = ["--skip-prebuild", "--skip-lifecycle", "--skip-slash-help", "--skip-qa"];

describe("plugin gateway gauntlet helpers", () => {
  let repoRoot: string;
  let outputDir: string;
  let receipts: FixtureReceiptChannel;
  let fixtureCompletion: Promise<void> | undefined;

  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });

  afterAll(() => receipts.close());

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-gauntlet-"));
    outputDir = path.join(repoRoot, "artifacts");
    await fs.mkdir(path.join(repoRoot, "extensions"), { recursive: true });
  });

  afterEach(async () => {
    // Vitest runs afterEach before onTestFinished; preserve fixture PID records
    // and mocked clocks until an aborted body has finished its asynchronous cleanup.
    await fixtureCompletion;
    fixtureCompletion = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function writeFixture(file: string, source: string | string[]) {
    const target = path.resolve(repoRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Array.isArray(source) ? source.join("\n") : source, "utf8");
  }

  async function writeManifest(id: string, fields: Record<string, unknown> = {}) {
    await writeFixture(`extensions/${id}/openclaw.plugin.json`, JSON.stringify({ id, ...fields }));
  }

  async function writeDependentPlugins() {
    await writeManifest("alpha", { requiresPlugins: ["beta"] });
    await writeManifest("beta");
    for (const id of ["alpha", "beta"]) {
      await writeFixture(`extensions/${id}/index.ts`, "export {};\n");
    }
  }

  async function writeQaRunner(body: string[]) {
    await writeFixture("scripts/run-node.mjs", [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const outputArgIndex = process.argv.indexOf("--output-dir");',
      "const outputDir = path.resolve(process.cwd(), process.argv[outputArgIndex + 1]);",
      "fs.mkdirSync(outputDir, { recursive: true });",
      ...body,
    ]);
  }

  function measure(
    params: Pick<runner.GauntletMeasuredCommandParams, "args" | "label"> &
      Partial<runner.GauntletMeasuredCommandParams>,
  ) {
    return runner.runMeasuredCommand({
      cwd: repoRoot,
      env: process.env,
      logDir: path.join(repoRoot, "logs"),
      command: process.execPath,
      phase: "probe",
      timeoutMs: 1000,
      timeMode: "none",
      ...params,
    });
  }

  function runGauntlet(args: string[], env?: NodeJS.ProcessEnv) {
    return spawnSync(
      process.execPath,
      [
        "--import",
        tsxImport,
        path.resolve("scripts/check-plugin-gateway-gauntlet.mts"),
        "--repo-root",
        repoRoot,
        "--output-dir",
        outputDir,
        ...args,
      ],
      { cwd: path.resolve("."), encoding: "utf8", ...(env ? { env } : {}) },
    );
  }

  function runQaGauntlet(scenarios: string[], env?: NodeJS.ProcessEnv) {
    return runGauntlet(
      [
        "--skip-prebuild",
        "--skip-lifecycle",
        "--skip-slash-help",
        "--plugin",
        "alpha",
        ...scenarios.flatMap((id) => ["--qa-scenario", id]),
      ],
      env,
    );
  }

  async function readSummary() {
    return JSON.parse(
      await fs.readFile(path.join(outputDir, "plugin-gateway-gauntlet-summary.json"), "utf8"),
    );
  }

  async function runQaSummaryFailureScenario(params: {
    qaSummary?: unknown;
    scenarioIds?: string[];
    diagnosticFailure?: string;
    diagnosticDetail?: unknown;
    maxBytes?: string;
    rowAssertion?: "metrics" | "missing";
  }) {
    const diagnosticFailure = params.diagnosticFailure ?? "qa-summary-invalid";
    await writeManifest("alpha");
    await writeFixture("extensions/alpha/index.ts", "export {};\n");
    const summaryAction =
      params.qaSummary === undefined
        ? 'console.log("fake QA completed without writing qa-suite-summary.json");'
        : `fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), ${JSON.stringify(JSON.stringify(params.qaSummary))}, "utf8");`;
    await writeQaRunner([summaryAction]);

    const result = runQaGauntlet(
      params.scenarioIds ?? ["channel-chat-baseline"],
      params.maxBytes
        ? { ...process.env, OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_QA_SUMMARY_MAX_BYTES: params.maxBytes }
        : undefined,
    );

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain(`diagnostic=${diagnosticFailure}`);
    const summary = await readSummary();
    expect(summary.failures).toEqual([
      expect.objectContaining({
        ...(params.diagnosticDetail === undefined
          ? {}
          : { diagnosticDetail: params.diagnosticDetail }),
        diagnosticFailure,
        phase: "qa:rpc",
        pluginId: "alpha",
        status: 0,
      }),
    ]);
    if (params.rowAssertion) {
      const evidence =
        params.rowAssertion === "metrics"
          ? { qaMetrics: { gatewayCpuCoreRatio: 0, wallMs: 1 } }
          : {
              qaSummaryPath: path.join(outputDir, "qa-suite", "chunk-00", "qa-suite-summary.json"),
            };
      expect(summary.rows[0]).toEqual(expect.objectContaining({ diagnosticFailure, ...evidence }));
    }
    expect(summary.isolatedRunRootPreserved).toBe(true);
    await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
  }

  function minimalQaSuiteSummary() {
    return {
      counts: { failed: 0, passed: 1, total: 1 },
      metrics: { gatewayCpuCoreRatio: 0, wallMs: 1 },
      run: { status: "completed" },
      scenarios: [
        {
          name: "channel-chat-baseline",
          status: "pass",
          steps: [{ name: "mock step", status: "pass" }],
        },
      ],
    };
  }

  function failedQaSummary(failed = 1) {
    return {
      ...minimalQaSuiteSummary(),
      counts: { failed, passed: 1, total: 2 },
      scenarios: [
        { name: "channel-chat-baseline", status: "pass", steps: [] },
        { name: "gateway-restart-inflight-run", status: "fail", steps: [] },
      ],
    };
  }

  function trackFixtureCompletion<T>(fixture: Promise<T>): Promise<T> {
    // The body retains its failure; both teardown paths join its existing cleanup.
    const settled = fixture.then(
      () => undefined,
      () => undefined,
    );
    fixtureCompletion = settled;
    onTestFinished(() => settled);
    return fixture;
  }

  async function fixtureReadyBeforeSettlement(readyPath: string, operation: Promise<unknown>) {
    const readReady = () =>
      fs.readFile(readyPath, "utf8").catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return "";
        }
        throw error;
      });
    // Receipt delivery and command settlement are unordered; the fixture writes
    // this durable record before it exits or lets its parent proceed.
    const settled = operation.then(
      async () => {
        if ((await readReady()) !== "ready") {
          throw new Error("condition was not met before timeout");
        }
      },
      async (error: unknown) => {
        if ((await readReady()) !== "ready") {
          throw error;
        }
      },
    );
    await Promise.race([receipts.waitFor(readyPath, "ready"), settled]);
  }

  async function waitForDead(pid: number, signal: AbortSignal) {
    // The command joins its process group, but Darwin can still expose a zombie
    // PID until the orphan is reaped. No ChildProcess handle owns that final reap.
    while (isProcessAlive(pid)) {
      try {
        await delay(5, undefined, { signal });
      } catch (error) {
        throw new Error(`process still alive: ${pid}`, { cause: error });
      }
    }
  }

  it.each([
    [
      "stops parsing after the argument terminator",
      ["--plugin", "telegram", "--", "--plugin", "discord"],
      { pluginIds: ["telegram"] },
    ],
    [
      "accepts a leading package-manager separator",
      ["--", "--plugin", "telegram", "--limit", "3", "--qa-scenario", "channel-chat-baseline"],
      { limit: 3, pluginIds: ["telegram"], qaScenarios: ["channel-chat-baseline"] },
    ],
  ] satisfies Array<[string, string[], Partial<ReturnType<typeof runner.parseArgs>>]>)(
    "%s",
    (_name, args, expected) => {
      expect(runner.parseArgs(args)).toMatchObject(expected);
    },
  );

  it("rejects duplicate repeatable selectors", () => {
    expect(() => runner.parseArgs(["--plugin", "telegram", "--plugin", "telegram"])).toThrow(
      "Duplicate --plugin value: telegram",
    );
    expect(() =>
      runner.parseArgs([
        "--qa-scenario",
        "channel-chat-baseline",
        "--qa-scenario",
        "channel-chat-baseline",
      ]),
    ).toThrow("Duplicate --qa-scenario value: channel-chat-baseline");

    vi.stubEnv("OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_IDS", "telegram,discord");
    expect(() => runner.parseArgs(["--plugin", "telegram"])).toThrow(
      "Duplicate --plugin value: telegram",
    );
  });

  it.each([
    ["--output-dir", ".artifacts/one", ".artifacts/two"],
    ["--shard-total", "2", "3"],
  ])("rejects duplicate single-value control %s", (flag, first, second) => {
    expect(() => runner.parseArgs([flag, first, flag, second])).toThrow(
      `${flag} was provided more than once`,
    );
  });

  it("rejects valued flags followed by another option", () => {
    const flags = `--repo-root --output-dir --plugin --shard-total --shard-index --limit
      --qa-scenario --qa-plugin-chunk-size --cpu-core-warn --hot-wall-warn-ms --max-rss-warn-mb
      --wall-anomaly-multiplier --rss-anomaly-multiplier --qa-cpu-regression-multiplier
      --qa-wall-regression-multiplier --command-timeout-ms --build-timeout-ms --qa-timeout-ms`;
    for (const flag of flags.split(/\s+/u)) {
      for (const value of ["--skip-qa", "-h"]) {
        expect(() => runner.parseArgs([flag, value])).toThrow(`Missing value for ${flag}`);
      }
    }
  });

  it("discovers bundled plugin manifests into lifecycle matrix rows", async () => {
    await writeManifest("alpha", {
      enabledByDefault: true,
      providers: ["openai"],
      commandAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
      auth: [{ method: "oauth", onboardingScopes: ["models"] }],
      configSchema: { properties: { nested: { required: ["token"] } } },
    });
    await writeManifest("beta", { commandAliases: ["dreaming"], onboardingScopes: ["memory"] });
    await writeManifest("kimi-coding", { id: "kimi" });
    await writeManifest("qa-lab");

    const matrix = gauntlet.discoverBundledPluginManifests(repoRoot);

    expect(matrix.map((entry) => entry.id)).toEqual(["alpha", "beta", "kimi"]);
    expect(matrix[0]).toEqual({
      activation: {},
      authMethods: ["oauth"],
      buildId: "alpha",
      channels: [],
      cliCommandAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
      commandAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
      dir: path.join("extensions", "alpha"),
      enabledByDefault: true,
      hasConfigSchema: true,
      hasRequiredConfigFields: true,
      id: "alpha",
      manifestPath: path.join("extensions", "alpha", "openclaw.plugin.json"),
      name: "alpha",
      onboardingScopes: ["models"],
      providers: ["openai"],
      requiredPlugins: [],
      runtimeSlashAliases: [{ name: "alpha", kind: "runtime-slash", cliCommand: "plugins" }],
      skills: [],
    });
    const beta = expectDefined(matrix[1], "beta bundled plugin manifest");
    expect(beta.runtimeSlashAliases).toEqual([
      { name: "dreaming", kind: "runtime-slash", cliCommand: null },
    ]);
    expect(beta.buildId).toBe("beta");
    const kimi = expectDefined(matrix[2], "Kimi bundled plugin manifest");
    expect(kimi).toMatchObject({ buildId: "kimi-coding", id: "kimi" });
    expect(gauntlet.buildGauntletPrebuildEnv({}, { buildIds: [kimi.buildId] })).toEqual({
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "kimi-coding",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    });
  });

  it("detects plugin load failures in successful command output", () => {
    expect(
      gauntlet.detectCommandDiagnosticFailure(
        "Installed plugin: qa-lab\n",
        "[plugins] qa-lab failed to load from /repo/extensions/qa-lab/index.ts: Error: nope\n",
      ),
    ).toBe("plugin-load-failure");
    expect(
      gauntlet.detectCommandDiagnosticFailure(
        "",
        "\u001B[36m[plugins]\u001B[39m qa-lab failed to load from /repo/extensions/qa-lab/index.ts: Error: nope\n",
      ),
    ).toBe("plugin-load-failure");
    expect(gauntlet.detectCommandDiagnosticFailure("Installed plugin: qa-lab\n", "")).toBeNull();
  });

  it("selects plugin shards after explicit id filtering", () => {
    const entries = ["a", "b", "c", "d"].map((id) => ({ id }));

    expect(
      gauntlet.selectPluginEntries(entries, { ids: ["d", "b"], shardTotal: 2, shardIndex: 0 }),
    ).toEqual([{ id: "b" }]);
    expect(() => gauntlet.selectPluginEntries(entries, { ids: ["missing"] })).toThrow(
      "Unknown bundled plugin id(s): missing",
    );
  });

  it("collects required plugin support outside the selected shard", () => {
    const entries = [
      { id: "alpha", requiredPlugins: ["beta"] },
      { id: "beta", requiredPlugins: ["gamma"] },
      { id: "gamma" },
      { id: "delta" },
    ];
    const selected = gauntlet.selectPluginEntries(entries, {
      ids: ["alpha"],
      shardTotal: 2,
      shardIndex: 0,
    });

    expect(
      gauntlet.collectRequiredPluginEntries(entries, selected).map((entry) => entry.id),
    ).toEqual(["gamma", "beta"]);
    expect(
      gauntlet.collectPluginsWithRequiredEntries(entries, selected).map((entry) => entry.id),
    ).toEqual(["gamma", "beta", "alpha"]);
  });

  it.each([
    {
      name: "missing requirements",
      entries: [{ id: "alpha", requiredPlugins: ["missing"] }],
      error: 'Bundled plugin "alpha" requires unknown bundled plugin "missing"',
    },
    {
      name: "requirement cycles",
      entries: [
        { id: "alpha", requiredPlugins: ["beta"] },
        { id: "beta", requiredPlugins: ["alpha"] },
      ],
      error: "Bundled plugin dependency cycle detected: alpha -> beta -> alpha",
    },
  ])("rejects bundled plugin $name", ({ entries, error }) => {
    expect(() =>
      gauntlet.collectRequiredPluginEntries(entries, [
        expectDefined(entries[0], "alpha plugin entry"),
      ]),
    ).toThrow(error);
  });

  it("flags gateway startup CPU observations using bench summary keys", () => {
    expect(
      gauntlet.collectGatewayCpuObservations({
        startup: {
          results: [
            {
              id: "default",
              summary: { cpuCoreRatio: { max: 1.1 }, readyzMs: { max: 45_000 } },
            },
          ],
        },
        qa: { metrics: { gatewayCpuCoreRatio: 1.2, wallMs: 60_000 } },
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 30_000,
      }),
    ).toEqual([
      { kind: "startup-cpu-hot", id: "default", cpuCoreRatioMax: 1.1, wallMsMax: 45_000 },
      { kind: "qa-cpu-hot", id: "qa-suite", cpuCoreRatio: 1.2, wallMs: 60_000 },
    ]);
  });

  it.each([false, true])("flags metric anomalies (cold start=%s)", (coldStart) => {
    const peak = { phase: "lifecycle:install", wallMs: 1_000, cpuCoreRatio: 1.2, maxRssMb: 500 };
    const ordinary = [
      { phase: "lifecycle:install", wallMs: 100, maxRssMb: 100 },
      { phase: "lifecycle:install", wallMs: 110, maxRssMb: 110 },
    ];
    const observations = gauntlet.collectMetricObservations(
      coldStart
        ? [{ phase: "prebuild", wallMs: 100, maxRssMb: 100 }, peak, ...ordinary]
        : [...ordinary, peak],
      {
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 900,
        maxRssWarnMb: 450,
        wallAnomalyMultiplier: 3,
        rssAnomalyMultiplier: 2.5,
      },
    );

    expect(observations.map((observation) => observation.kind)).toEqual([
      "phase-cpu-hot",
      "phase-wall-anomaly",
      "phase-rss-high",
      "phase-rss-anomaly",
    ]);
    if (coldStart) {
      for (const observation of observations) {
        expect(observation).toMatchObject({ coldStart: true });
      }
    }
  });

  it("uses QA gateway metrics instead of source CLI wrapper CPU for QA hot observations", () => {
    const observations = gauntlet.collectMetricObservations(
      [
        {
          phase: "qa:rpc",
          wallMs: 40_000,
          cpuCoreRatio: 1.2,
          qaMetrics: { wallMs: 25_000, gatewayCpuCoreRatio: 0.42 },
        },
      ],
      {
        cpuCoreWarn: 0.9,
        hotWallWarnMs: 30_000,
      },
    );

    expect(observations).toStrictEqual([]);
  });

  it("flags QA gateway regressions relative to an explicit baseline", () => {
    expect(
      gauntlet
        .collectQaBaselineRegressionObservations(
          [
            {
              pluginId: "<baseline>",
              phase: "qa:rpc",
              qaMetrics: { wallMs: 20_000, gatewayCpuCoreRatio: 0.25 },
            },
            {
              pluginId: "plugin",
              phase: "qa:rpc",
              qaMetrics: { wallMs: 45_000, gatewayCpuCoreRatio: 0.6 },
            },
          ],
          {
            cpuRegressionMultiplier: 2,
            wallRegressionMultiplier: 2,
          },
        )
        .map((observation) => observation.kind),
    ).toEqual(["qa-baseline-cpu-regression", "qa-baseline-wall-regression"]);
  });

  it("prebuilds private QA dist when QA chunks are enabled", () => {
    expect(
      gauntlet.buildGauntletPrebuildEnv({ EXISTING: "1" }, { includePrivateQa: true }),
    ).toEqual({
      EXISTING: "1",
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "qa-channel,qa-lab",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    });
    const env = { EXISTING: "1" };
    expect(gauntlet.buildGauntletPrebuildEnv(env, { includePrivateQa: false })).toBe(env);
  });

  it("prebuilds only the QA runtime needed by the gauntlet", () => {
    expect(runner.createGauntletPrebuildCommand(repoRoot)).toEqual({
      command: process.execPath,
      args: ["--import", "tsx", path.join(repoRoot, "scripts", "build-all.mts"), "qaRuntime"],
    });
  });

  it("does not count prebuild setup as gauntlet work", () => {
    expect(runner.hasGauntletWorkRows([])).toBe(false);
    expect(runner.hasGauntletWorkRows([{ phase: "prebuild" }])).toBe(false);
    expect(
      runner.hasGauntletWorkRows([{ phase: "prebuild" }, { phase: "lifecycle:install" }]),
    ).toBe(true);
    expect(runner.hasGauntletWorkRows([{ phase: "slash:help" }])).toBe(true);
    expect(runner.hasGauntletWorkRows([{ phase: "qa:rpc" }])).toBe(true);
  });

  it("parses macOS time -l metrics from strict trailing lines", () => {
    const metrics = runner.parseTimedMetrics(
      [
        "plugin stderr: 99.00 real 99.00 user 99.00 sys nope",
        "        0.25 real         0.06 user         0.02 sys",
        "     2097152  maximum resident set size",
      ].join("\n"),
      250,
      "bsd",
    );

    expect(metrics).toMatchObject({ cpuMs: 80, maxRssMb: 2 });
    expect(metrics.cpuCoreRatio).toBeCloseTo(0.32);
  });

  it("marks spawn errors as failed measured rows", async () => {
    const row = await measure({
      command: path.join(repoRoot, "missing-command"),
      args: [],
      label: "missing",
    });

    expect(row).toMatchObject({ status: 1, spawnError: { code: "ENOENT" } });
    await expect(fs.readFile(row.logPath!, "utf8")).resolves.toContain("[spawn error] ENOENT");
  });

  it("clamps oversized measured command timers before scheduling", async () => {
    const row = await measure({
      args: ["-e", "setTimeout(() => process.exit(0), 25)"],
      label: "oversized-timeout",
      timeoutKillGraceMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(row).toMatchObject({ status: 0, timedOut: false });
    await expect(fs.readFile(row.logPath!, "utf8")).resolves.not.toContain("ETIMEDOUT");
  });

  it.runIf(process.platform !== "win32").for([
    { label: "normal-leader-exits", normalExit: true },
    { label: "timeout-leader-exits", normalExit: false },
  ])("cleans measured process groups after $label", async ({ label, normalExit }, { signal }) => {
    const scriptPath = path.join(repoRoot, "leader-exits.mjs");
    const grandchildPidPath = path.join(repoRoot, "grandchild.pid");
    const readyPath = path.join(repoRoot, "grandchild.ready");
    let grandchildPid = 0;
    await writeMeasuredLeader(scriptPath, "exit");

    const rowPromise = measure({
      args: [scriptPath, grandchildPidPath, readyPath, normalExit ? "normal" : "timeout"],
      label,
      timeoutKillGraceMs: 25,
      timeoutMs: normalExit ? 1000 : 250,
    });
    // Observe early rejection while readiness is checked; the original is awaited below.
    void rowPromise.catch(() => undefined);

    await trackFixtureCompletion(
      runQaGatewayFixture(
        async () => {
          await withinTest(fixtureReadyBeforeSettlement(readyPath, rowPromise), signal);
          grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
          expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 1).toBe(true);
          if (!normalExit) {
            expect(isProcessAlive(grandchildPid)).toBe(true);
          }

          const row = await withinTest(rowPromise, signal);
          expect(row.timedOut).toBe(!normalExit);
          if (normalExit) {
            expect(row.status).toBe(1);
          }
          expect(row.spawnError?.code).toBe(
            normalExit ? "EPROCESSGROUP_CLEANUP_FAILED" : "ETIMEDOUT",
          );
          await waitForDead(grandchildPid, signal);
        },
        async () => {
          if (!grandchildPid) {
            try {
              grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
            } catch (error) {
              if (hasErrnoCode(error, "ENOENT")) {
                return;
              }
              throw error;
            }
          }
          await reapFixturePid(grandchildPid, signal, { onlyIfAlive: true });
        },
        async () => {
          await rowPromise;
        },
      ),
    );
  });

  it.runIf(process.platform !== "win32")(
    "lets timed-out measured command descendants drain during kill grace",
    async ({ signal }) => {
      const scriptPath = path.join(repoRoot, "leader-exits-drain.mjs");
      const readyPath = path.join(repoRoot, "grandchild.ready");
      const drainedPath = path.join(repoRoot, "grandchild.drained");
      await writeMeasuredLeader(scriptPath, "drain");

      const rowPromise = measure({
        args: [scriptPath, readyPath, drainedPath],
        label: "timeout-leader-drain",
        timeoutKillGraceMs: 200,
        timeoutMs: 500,
      });

      await trackFixtureCompletion(
        runQaGatewayFixture(
          async () => {
            await withinTest(fixtureReadyBeforeSettlement(readyPath, rowPromise), signal);
            const row = await withinTest(rowPromise, signal);

            expect(row).toMatchObject({ timedOut: true, spawnError: { code: "ETIMEDOUT" } });
            await expect(fs.readFile(drainedPath, "utf8")).resolves.toBe("drained");
          },
          () => rowPromise,
        ),
      );
    },
  );

  it("returns a failed row when measured command log writing fails", async () => {
    const logDir = path.join(repoRoot, "not-a-directory");
    await fs.writeFile(logDir, "blocks log directory creation", "utf8");

    const row = await measure({
      logDir,
      args: ["-e", "console.log('live stdout')"],
      label: "live-log-failure",
    });

    expect(row).toMatchObject({
      status: 1,
      diagnosticFailure: "command-log-write-failure",
      logPath: null,
      logWriteError: expect.stringMatching(/EEXIST|ENOTDIR|not a directory/u),
    });
  });

  async function writeMeasuredLeader(
    scriptPath: string,
    mode: "exit" | "drain" | "parent" | "timeout",
  ) {
    const ipcReady = mode === "timeout";
    const childScript =
      mode === "drain"
        ? `
const fs = require('node:fs');
process.on('SIGTERM', () => {
  setTimeout(() => {
    fs.writeFileSync(process.argv[3], 'drained');
    process.exit(0);
  }, 20);
});
process.send('ready');
setInterval(() => {}, 1000);
`
        : mode === "exit"
          ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"
          : `process.on('SIGTERM', () => {});
process.on('SIGHUP', () => {});
process.send('ready');
setInterval(() => {}, 1000);`;
    await writeFixture(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

${ipcReady ? "" : fixtureReceiptClientSource(receipts.endpoint)}
const mode = ${JSON.stringify(mode)};
const normalExit = mode === "exit" && process.argv[4] === "normal";
const childArgs = mode === "drain" ? ["child", process.argv[2], process.argv[3]]
  : mode === "parent" ? ["child", process.argv[3]] : [];
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}, ...childArgs], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
if (mode === "exit") {
  // Publish atomically so failed startup still has an owned rescue target.
  fs.writeFileSync(process.argv[2] + ".tmp", String(grandchild.pid));
  fs.renameSync(process.argv[2] + ".tmp", process.argv[2]);
} else if (mode !== "drain") {
  fs.writeFileSync(process.argv[2], String(grandchild.pid));
}
const exitOnTerm = () => process.exit(0);
if (mode === "timeout") process.on("SIGTERM", exitOnTerm);
grandchild.once("message", () => {
  if (mode === "timeout") return process.send("ready", () => process.disconnect());
  const readyPath = mode === "drain" ? process.argv[2] : process.argv[3];
  fs.writeFileSync(readyPath, "ready");
  sendReceipt(readyPath, "ready");
  if (normalExit) process.exit(0);
});
if (mode !== "timeout") process.on("SIGTERM", exitOnTerm);
if (!normalExit) setInterval(() => {}, 1000);
`,
    );
  }

  function measuredHarnessSource(params: Partial<runner.GauntletMeasuredCommandParams>) {
    return `runMeasuredCommand({ ...${JSON.stringify({
      cwd: repoRoot,
      logDir: path.join(repoRoot, "logs"),
      phase: "probe",
      timeMode: "none",
      ...params,
    })}, command: process.execPath, env: process.env })`;
  }

  function spawnTerminationHarness(harnessPath: string) {
    const harness = spawn(testNodeExecPath, ["--import", tsxImport, harnessPath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(harness, "close");
    void closed.catch(() => undefined);
    return { harness, closed };
  }

  async function readOptionalPid(pidPath: string) {
    return fs
      .readFile(pidPath, "utf8")
      .then(Number)
      .catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
  }

  async function reapFixturePid(
    pid: number,
    signal: AbortSignal,
    { group = false, onlyIfAlive = false } = {},
  ) {
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    try {
      if (!onlyIfAlive || isProcessAlive(pid)) {
        process.kill(group ? -pid : pid, "SIGKILL");
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
    }
    await waitForDead(pid, signal);
  }

  it.runIf(process.platform !== "win32")(
    "cleans parent-terminated measured process groups when the leader exits first",
    async ({ signal }) => {
      const harnessPath = path.join(repoRoot, "parent-termination-harness.mjs");
      const scriptPath = path.join(repoRoot, "parent-termination-leader.mjs");
      const grandchildPidPath = path.join(repoRoot, "grandchild.pid");
      const grandchildReadyPath = path.join(repoRoot, "grandchild.ready");
      let grandchildPid = 0;

      await writeMeasuredLeader(scriptPath, "parent");
      await writeFixture(
        harnessPath,
        `
import { runMeasuredCommand } from ${JSON.stringify(
          resolveRuntimeWorkerUrl(toolingMtsEntrypoints.pluginGatewayGauntlet).href,
        )};

await ${measuredHarnessSource({
          args: [scriptPath, grandchildPidPath, grandchildReadyPath],
          label: "parent-termination-leader-exits",
          timeoutKillGraceMs: 25,
          timeoutMs: 60_000,
        })};
`,
      );

      const { harness, closed } = spawnTerminationHarness(harnessPath);
      await trackFixtureCompletion(
        (async () => {
          try {
            await withinTest(fixtureReadyBeforeSettlement(grandchildReadyPath, closed), signal);
            grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
            expect(isProcessAlive(grandchildPid)).toBe(true);

            harness.kill("SIGTERM");
            await expect(withinTest(closed, signal)).resolves.toEqual([null, "SIGTERM"]);
            await waitForDead(grandchildPid, signal);
          } finally {
            if (harness.pid && isProcessAlive(harness.pid)) {
              harness.kill("SIGTERM");
            }
            await closed;
            if (!grandchildPid) {
              grandchildPid = (await readOptionalPid(grandchildPidPath)) ?? 0;
            }
            if (grandchildPid && isProcessAlive(grandchildPid)) {
              process.kill(grandchildPid, "SIGKILL");
            }
            if (grandchildPid) {
              await waitForDead(grandchildPid, signal);
            }
          }
        })(),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rethrows parent termination received during timeout cleanup",
    async ({ signal }) => {
      const harnessPath = path.join(repoRoot, "timeout-parent-termination-harness.mjs");
      const scriptPath = path.join(repoRoot, "timeout-parent-termination-leader.mjs");
      const grandchildPidPath = path.join(repoRoot, "timeout-grandchild.pid");
      const grandchildReadyPath = path.join(repoRoot, "timeout-grandchild.ready");
      const leaderPidPath = path.join(repoRoot, "timeout-leader.pid");
      let grandchildPid = 0;

      await writeMeasuredLeader(scriptPath, "timeout");
      await writeFixture(
        harnessPath,
        `
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import fs from "node:fs";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runMeasuredCommand } from ${JSON.stringify(
          resolveRuntimeWorkerUrl(toolingMtsEntrypoints.pluginGatewayGauntlet).href,
        )};

import { inspectManagedProcessGroup } from ${JSON.stringify(
          resolveRuntimeWorkerUrl(toolingMtsEntrypoints.managedChildProcess).href,
        )};

${fixtureReceiptClientSource(receipts.endpoint)}

const realDelay = delay;
// Mocked timers cannot keep Node alive while a native signal is in flight.
const keepAlive = setInterval(() => {}, 1_000);
const children = channel("child_process");
let child, ready, closed;
const observeChild = ({ process: owned }) => {
  child = owned;
  ready = once(child, "message");
  closed = once(child, "close");
};
// Only the controller's policy clock is mocked; readiness, exit, and signals are native.
mock.timers.enable({ apis: ["Date", "setTimeout"] });
children.subscribe(observeChild);
const promise = ${measuredHarnessSource({
          args: [scriptPath, grandchildPidPath],
          label: "timeout-parent-termination",
          timeoutKillGraceMs: 150,
          timeoutMs: 200,
          spawnOptions: { stdio: ["ignore", "pipe", "pipe", "ipc"] },
        })};
children.unsubscribe(observeChild);
fs.writeFileSync(${JSON.stringify(leaderPidPath)}, String(child.pid));
try {
  assert.equal((await ready)[0], "ready");
  fs.writeFileSync(${JSON.stringify(grandchildReadyPath)}, "ready");
  sendReceipt(${JSON.stringify(grandchildReadyPath)}, "ready");
  mock.timers.tick(200);
  assert.deepEqual(await closed, [0, null]);
  assert.equal(inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }), "live");
  const termination = once(process, "SIGTERM");
  process.kill(process.pid, "SIGTERM");
  await termination;
  mock.timers.tick(150);
  await new Promise(setImmediate);
  const deadline = performance.now() + 5_000;
  while (inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }) !== "dead") {
    assert.ok(performance.now() < deadline, "process group survived SIGKILL");
    await realDelay(5);
  }
  // Linux can retain a zombie group after native death. Drain the owner's existing
  // 100 ms post-KILL fallback before expecting its original parent signal.
  mock.timers.tick(100);
  await promise;
  process.exitCode = 7;
} finally {
  mock.timers.reset();
  clearInterval(keepAlive);
}
`,
      );

      const { harness, closed } = spawnTerminationHarness(harnessPath);
      let stderr = "";
      harness.stdout.resume();
      harness.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const reapPidFile = async (pidPath: string, group = false) => {
        const pid = await readOptionalPid(pidPath);
        if (pid === undefined) {
          return;
        }
        await reapFixturePid(pid, signal, { group });
      };
      await trackFixtureCompletion(
        runQaGatewayFixture(
          async () => {
            await withinTest(
              fixtureReadyBeforeSettlement(grandchildReadyPath, closed),
              signal,
            ).catch((error: unknown) => {
              throw new Error(`${String(error)}\n${stderr}`, { cause: error });
            });
            grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);

            expect(await withinTest(closed, signal), stderr).toEqual([null, "SIGTERM"]);
            await waitForDead(grandchildPid, signal);
          },
          () => reapPidFile(leaderPidPath, true),
          () => reapPidFile(grandchildPidPath),
          async () => {
            if (harness.pid && isProcessAlive(harness.pid)) {
              harness.kill("SIGKILL");
            }
            await closed;
          },
        ),
      );
    },
  );

  it("bounds captured output from live measured commands", async () => {
    const before = process.listenerCount("SIGTERM");
    const row = await measure({
      args: ["-e", "process.stdout.write('x'.repeat(32)); process.stderr.write('y'.repeat(32))"],
      label: "live-bounded",
      maxBufferBytes: 12,
    });

    expect(row.status).toBe(0);
    const log = await fs.readFile(row.logPath!, "utf8");
    expect(log).toContain("x".repeat(12));
    expect(log).toContain("[stdout truncated after 12 bytes]");
    expect(log).toContain("y".repeat(12));
    expect(log).toContain("[stderr truncated after 12 bytes]");
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("bounds relayed output from live measured commands", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    });

    const row = await measure({
      args: ["-e", "process.stdout.write('x'.repeat(32))"],
      label: "live-relay-bounded",
      consoleOutputMaxBytes: 12,
      maxBufferBytes: 64,
    });

    const relayed = writes.join("");
    expect(row.status).toBe(0);
    expect(relayed).toContain("x".repeat(12));
    expect(relayed).not.toContain("x".repeat(32));
    expect(relayed).toContain("[stdout relay truncated after 12 bytes]");
    await expect(fs.readFile(row.logPath!, "utf8")).resolves.toContain("x".repeat(32));
  });

  it("force kills timed-out live measured process groups that ignore SIGTERM", async ({
    signal,
  }) => {
    const markerPath = path.join(repoRoot, "timeout-marker.txt");
    const watcher = watch(repoRoot);
    const ready = new Promise<void>((resolve, reject) => {
      watcher.on("error", reject);
      watcher.on("change", (_event, filename) => {
        if (filename?.toString() === path.basename(markerPath)) {
          resolve();
        }
      });
    });
    const scheduleTimeout = globalThis.setTimeout;
    let fireDeadline: (() => void) | undefined;
    // Drive only the policy deadline after the real child's signal handler is ready.
    const timerSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, ms, ...args) => {
        const timer = scheduleTimeout(callback, ms, ...args);
        if (ms === 100 && !fireDeadline) {
          clearTimeout(timer);
          fireDeadline = () => {
            fireDeadline = undefined;
            callback(...args);
          };
        }
        return timer;
      });
    const command = measure({
      timeMode: undefined,
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "const marker = process.argv[1];",
          "process.on('SIGTERM', () => fs.appendFileSync(marker, 'term\\n'));",
          "fs.writeFileSync(marker, 'start\\n');",
          "setInterval(() => fs.appendFileSync(marker, 'tick\\n'), 1);",
        ].join(""),
        markerPath,
      ],
      label: "live-timeout",
      timeoutMs: 100,
      timeoutKillGraceMs: 10,
    });
    const row = await trackFixtureCompletion(
      (async () => {
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              ready,
              command,
              "measured process fixture did not become ready",
            ),
            signal,
          );
          watcher.close();
          timerSpy.mockRestore();
          expectDefined(fireDeadline, "command deadline should be armed before readiness")();
          return await withinTest(command, signal);
        } finally {
          watcher.close();
          timerSpy.mockRestore();
          fireDeadline?.();
          await command;
        }
      })(),
    );

    expect(row).toMatchObject({ status: 1, timedOut: true, spawnError: { code: "ETIMEDOUT" } });
    expect(row.wallMs).toBeLessThan(5_000);
    const afterReturn = await fs.readFile(markerPath, "utf8");
    await delay(30);
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe(afterReturn);
  });

  it("fails dry runs that do not execute any gauntlet commands", async () => {
    const result = runGauntlet(dryRunArgs);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("No lifecycle, slash-help, or QA gauntlet commands ran");
    const summary = await readSummary();
    try {
      expect(summary.guardFailures).toEqual([
        expect.objectContaining({
          kind: "empty-run",
        }),
      ]);
      expect(summary.isolatedRunRootPreserved).toBe(true);
      await expect(fs.stat(summary.isolatedRunRoot)).resolves.toBeTruthy();
      const config = JSON.parse(
        await fs.readFile(path.join(summary.isolatedRunRoot, "state", "openclaw.json"), "utf8"),
      );
      expect(config).toMatchObject({
        logging: { file: path.join(summary.isolatedRunRoot, "logs", "openclaw.log") },
      });
    } finally {
      await fs.rm(summary.isolatedRunRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-decimal gauntlet numeric options", () => {
    const result = runGauntlet([...dryRunArgs, "--allow-empty", "--limit", "1e3"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--limit must be a positive integer");
  });

  it("fails once when skip-prebuild leaves plugin lifecycle probes without a built entry", async () => {
    await writeManifest("acpx");

    const result = runGauntlet(["--skip-prebuild", "--skip-qa", "--plugin", "acpx"]);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Cannot find module");
    expect(result.stderr).not.toContain("[plugin-gauntlet] acpx install");
    expect(result.stdout).toContain("failure missing-built-entry");

    const summary = await readSummary();
    expect(summary).toMatchObject({
      rows: [],
      failures: [],
      guardFailures: [
        {
          kind: "missing-built-entry",
          message:
            "dist/entry.js is missing; run without --skip-prebuild or build the gauntlet runtime first.",
        },
      ],
    });
  });

  it("allows skip-prebuild slash-only dry runs when selected plugins have no slash probes", async () => {
    await writeManifest("acpx");

    const result = runGauntlet([
      "--skip-prebuild",
      "--skip-lifecycle",
      "--skip-qa",
      "--allow-empty",
      "--plugin",
      "acpx",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("missing-built-entry");

    const summary = await readSummary();
    expect(summary).toMatchObject({ rows: [], guardFailures: [] });
  });

  it("parses observation failure mode from CLI and env", () => {
    expect(runner.parseArgs(["--fail-on-observation", "--allow-empty"])).toMatchObject({
      allowEmpty: true,
      failOnObservation: true,
    });

    vi.stubEnv("OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_FAIL_ON_OBSERVATION", "1");
    expect(runner.parseArgs(["--allow-empty"])).toMatchObject({
      allowEmpty: true,
      failOnObservation: true,
    });
  });

  it("does not promote setup and first cold-start observations to guard failures", () => {
    const observations = [
      { kind: "phase-rss-high", phase: "prebuild" },
      { kind: "phase-wall-anomaly", phase: "lifecycle:install", coldStart: true },
      { kind: "phase-wall-anomaly", phase: "lifecycle:install" },
    ];

    expect(runner.buildObservationGuardFailures(observations, true)).toEqual([
      {
        kind: "observation:phase-wall-anomaly",
        message: "Gauntlet observation threshold exceeded: phase-wall-anomaly",
        observation: observations[2],
      },
    ]);
  });

  it("cleans the isolated run root after an explicitly empty dry run", async () => {
    const result = runGauntlet([...dryRunArgs, "--allow-empty"]);

    expect(result.status, result.stderr).toBe(0);
    const summary = await readSummary();
    expect(summary).toMatchObject({ guardFailures: [], isolatedRunRootPreserved: false });
    await expect(fs.stat(summary.isolatedRunRoot)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("probes plugin-owned slash help while the plugin is installed", async () => {
    await writeManifest("workboard", {
      commandAliases: [{ name: "workboard", kind: "runtime-slash", cliCommand: "workboard" }],
    });
    await writeFixture("extensions/workboard/index.ts", "export {};\n");
    await writeFixture("dist/entry.js", [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const stateDir = process.env.OPENCLAW_STATE_DIR ?? process.cwd();",
      'const marker = path.join(stateDir, "workboard-enabled");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "plugins") {',
      '  if (args[1] === "install" || args[1] === "enable") fs.writeFileSync(marker, "1");',
      '  if (args[1] === "disable" || args[1] === "uninstall") fs.rmSync(marker, { force: true });',
      '  if (args[1] === "inspect") console.log("{}");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "workboard" && args[1] === "--help") {',
      "  if (fs.existsSync(marker)) {",
      '    console.log("Usage: openclaw workboard");',
      "    process.exit(0);",
      "  }",
      '  console.error("workboard help was probed after uninstall");',
      "  process.exit(1);",
      "}",
      "process.exit(0);",
    ]);

    const result = runGauntlet(["--skip-prebuild", "--skip-qa", "--plugin", "workboard"]);

    expect(result.status, result.stderr).toBe(0);
    const summary = await readSummary();
    expect(summary.failures).toEqual([]);
    const slashHelpRow = summary.rows.find(
      (row: { label?: string; logPath?: string }) => row.label === "workboard-slash-help:workboard",
    );
    expect(slashHelpRow).toMatchObject({
      label: "workboard-slash-help:workboard",
      phase: "slash:help",
      pluginId: "workboard",
      status: 0,
    });
    const slashHelpLogPath = slashHelpRow?.logPath;
    expect(slashHelpLogPath).toEqual(expect.any(String));
    await expect(fs.readFile(slashHelpLogPath as string, "utf8")).resolves.toContain(
      "Usage: openclaw workboard",
    );
  });

  it("carries required plugin build ids and enables dependencies in QA chunks", async () => {
    const qaSummaryJson = JSON.stringify(minimalQaSuiteSummary());
    await writeDependentPlugins();
    await writeQaRunner([
      'fs.writeFileSync(path.join(outputDir, "env.txt"), process.env.OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS ?? "", "utf8");',
      'fs.writeFileSync(path.join(outputDir, "args.txt"), process.argv.slice(2).join("\\n"), "utf8");',
      `fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), ${JSON.stringify(qaSummaryJson)}, "utf8");`,
    ]);

    const result = runQaGauntlet(["channel-chat-baseline"]);

    expect(result.status, result.stderr).toBe(0);
    await expect(
      fs.readFile(path.join(outputDir, "qa-suite", "chunk-00", "env.txt"), "utf8"),
    ).resolves.toBe("alpha,beta,qa-channel,qa-lab");
    await expect(
      fs.readFile(path.join(outputDir, "qa-suite", "chunk-00", "args.txt"), "utf8"),
    ).resolves.toContain(["--enable-plugin", "beta", "--enable-plugin", "alpha"].join("\n"));
  });

  it("installs required plugins around a dependent plugin lifecycle probe", async () => {
    await writeDependentPlugins();
    await writeFixture("dist/entry.js", "if (process.argv[3] === 'inspect') console.log('{}');\n");

    const result = runGauntlet([
      "--skip-prebuild",
      "--skip-qa",
      "--skip-slash-help",
      "--plugin",
      "alpha",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const summary = await readSummary();
    expect(summary.rows.map((row: { label: string }) => row.label)).toEqual([
      "alpha-requires-beta-install",
      "alpha-install",
      "alpha-inspect",
      "alpha-disable",
      "alpha-enable",
      "alpha-doctor",
      "alpha-uninstall",
      "alpha-requires-beta-uninstall",
    ]);
  });

  it.each([
    {
      name: "reports failed scenarios",
      qaSummary: failedQaSummary(),
      scenarioIds: ["channel-chat-baseline", "gateway-restart-inflight-run"],
      diagnosticFailure: "qa-summary-failed-scenarios",
      diagnosticDetail: "QA suite reported 1 failed scenario(s)",
      rowAssertion: "metrics",
    },
    {
      name: "is still running",
      qaSummary: {
        ...minimalQaSuiteSummary(),
        run: { status: "running" },
      },
      diagnosticDetail: "QA suite summary run.status must be completed, got running",
    },
    {
      name: "has no step evidence",
      qaSummary: {
        ...minimalQaSuiteSummary(),
        scenarios: [{ name: "channel-chat-baseline", status: "pass", steps: [] }],
      },
      diagnosticDetail:
        "QA suite summary passed scenario has no step evidence: channel-chat-baseline",
    },
    {
      name: "has statuses disagreeing with counts",
      qaSummary: failedQaSummary(0),
      scenarioIds: ["channel-chat-baseline", "gateway-restart-inflight-run"],
      diagnosticDetail:
        "QA suite summary failed count mismatch: counts.failed=0, failed scenarios=1",
    },
    {
      name: "is missing",
      diagnosticFailure: "qa-summary-missing",
      rowAssertion: "missing",
    },
    {
      name: "is oversized",
      qaSummary: { filler: "x".repeat(128) },
      diagnosticDetail: expect.stringContaining("QA suite summary exceeded 64 bytes"),
      maxBytes: "64",
    },
  ] satisfies Array<Parameters<typeof runQaSummaryFailureScenario>[0] & { name: string }>)(
    "fails successful QA chunks whose summary $name",
    runQaSummaryFailureScenario,
  );
});
