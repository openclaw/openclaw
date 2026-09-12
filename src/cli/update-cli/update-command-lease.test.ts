import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageBundledPluginRuntime } from "../../../scripts/stage-bundled-plugin-runtime.mts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import {
  createUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";

const mocks = vi.hoisted(() => ({
  entrypoint: vi.fn(),
  root: vi.fn(),
  plugins: vi.fn<typeof import("./update-command-plugins.js").updatePluginsAfterCoreUpdate>(),
  restart: vi.fn(async () => "ok"),
  print: vi.fn(),
  publication: vi.fn(
    async (
      params: { assertCurrent: () => void },
      publish: (assertCurrent: () => Promise<void>) => Promise<unknown>,
    ) => {
      params.assertCurrent();
      return await publish(async () => params.assertCurrent());
    },
  ),
}));

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.entrypoint,
}));
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./update-command-fresh-doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-fresh-doctor.js")>()),
  // Package discovery is covered separately; this fixture exercises real
  // process/lease ownership at the Doctor and result-publication boundaries.
  convergeUpdateDoctorMigrationPlugins: vi.fn(async () => undefined),
}));
vi.mock("./progress.js", () => ({ printResult: mocks.print }));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
  tryWriteCompletionCache: vi.fn(async () => "skipped"),
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restart,
  tryInstallShellCompletion: vi.fn(),
}));
// Native service custody has separate boundary tests; this fixture retains the
// real plugin lease, artifact ownership, installed adapter, and canonical writer.
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  withGatewayRuntimeArtifactPublication: mocks.publication,
}));

// The fixture CLI owns lease probes and Doctor phases; triage has its own owner tests.
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => async () => ({ status: "completed", hint: "" }),
}));

import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import type { LeaseScenario } from "./update-command-lease.test-support.js";
import type { ProducedPluginUpdateResult } from "./update-command-plugins-internals.js";
import { finishUpdate } from "./update-command-post-update.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const pluginResult: ProducedPluginUpdateResult = {
  assessment: { kind: "no-payload-repair" },
  status: "ok",
  changed: true,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};
type Lane = LeaseScenario["lane"];
let state: OpenClawTestState;
let entrypoint: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.publication.mockReset().mockImplementation(async (params, publish) => {
    params.assertCurrent();
    return await publish(async () => params.assertCurrent());
  });
  state = await createOpenClawTestState({
    label: "update-lease",
    env: {
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: undefined,
      OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: undefined,
      OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: undefined,
      OPENCLAW_UPDATE_RUN_ID: undefined,
    },
  });
  // Config-write custody is stored outside the profile; isolate both process owners.
  const control = state.path("control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  await state.writeConfig({ plugins: { enabled: false }, update: { channel: "stable" } });
  await state.writeText("events.jsonl", "");
  entrypoint = await state.writeText(
    "entry.mjs",
    `
    import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
    import * as json5 from ${JSON.stringify(import.meta.resolve("json5"))};
    const loader = register({ namespace: "update-lease-fixture", tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
    const { registerSealedRuntime } = await loader.import(${JSON.stringify(new URL("../../infra/sealed-runtime-registry.ts", import.meta.url).href)}, import.meta.url);
    registerSealedRuntime({ json5, resolveSecureTempRoot: () => ${JSON.stringify(control)} });
    const { runUpdateLeaseChild } = await loader.import(${JSON.stringify(new URL("./update-command-lease.test-support.ts", import.meta.url).href)}, import.meta.url);
    await runUpdateLeaseChild();
    await loader.unregister();
  `,
  );
  await state.writeText("dist/index.mjs", await fs.readFile(entrypoint, "utf8"));
  mocks.entrypoint.mockResolvedValue(entrypoint);
  mocks.root.mockResolvedValue(state.root);
  mocks.plugins.mockReset().mockResolvedValue(pluginResult);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

async function writeScenario(
  lane: Lane,
  scenario: Omit<LeaseScenario, "lane"> = {},
): Promise<void> {
  // Fresh-process fixtures must advertise a runtime supporting continuation;
  // legacy targets intentionally exercise the current-process fallback.
  await fs.writeFile(
    state.path("package.json"),
    JSON.stringify({ version: lane === "fresh-process" ? VERSION : "1.0.0" }),
  );
  await state.writeJson("scenario.json", { pluginUpdate: pluginResult, ...scenario, lane });
}

async function invoke(lane: Lane, recoveryRunIds: readonly string[] = []): Promise<void> {
  if (lane === "resume") {
    return resumePostCoreUpdate({
      root: state.root,
      channel: "stable",
      opts: { json: true, yes: true },
      timeoutMs: 15_000,
    });
  }
  if (lane === "repair") {
    return updateFinalizeCommand(
      {
        json: true,
        yes: true,
        restart: false,
        timeout: "15",
        deferCompletionCache: true,
      },
      recoveryRunIds,
    );
  }
  await finishUpdate({
    mutationStarted: true,
    result: {
      status: "ok",
      mode: "npm",
      root: state.root,
      before: { version: lane === "fresh-process" ? "0.9.0" : "2.0.0" },
      after: { version: lane === "fresh-process" ? VERSION : "1.0.0" },
      steps: [],
      durationMs: 1,
    },
    root: state.root,
    installKindChanged: false,
    configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
    requestedChannel: null,
    storedChannel: "stable",
    channel: "stable",
    downgradeRisk: lane !== "fresh-process",
    shouldRestart: false,
    opts: { json: true, yes: true },
    ownedManagedUpdateEnv: { ...process.env },
    controlPlaneUpdateSentinelMeta: null,
    preUpdatePluginInstallRecords: { stale: { source: "path", sourcePath: state.path("stale") } },
    startedAt: Date.now(),
    updateStepTimeoutMs: 15_000,
  });
}

async function invokeReportedFailure(
  lane: Lane,
  recoveryRunIds: readonly string[] = [],
): Promise<void> {
  await expect(invoke(lane, recoveryRunIds)).rejects.toMatchObject(
    lane === "repair"
      ? { name: "ExitError", code: 1 }
      : { name: "UpdateCommandFailure", exitCode: 1 },
  );
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
}

async function events(): Promise<string[]> {
  return (await fs.readFile(state.statePath("events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as { event: string; pid: number };
      expect(event.pid).not.toBe(process.pid);
      return event.event;
    });
}

function expectDoctorDiagnostics(): void {
  expect(defaultRuntime.log).not.toHaveBeenCalledWith(expect.stringContaining("doctor fixture"));
  expect(defaultRuntime.error).toHaveBeenCalledWith("doctor fixture output");
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("doctor fixture diagnostic"),
  );
}

function expectSuccess(lane: Lane, doctorExpected = true): void {
  expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  expect(reportedResult(lane)).toMatchObject({
    status: "ok",
    postUpdate: { plugins: { status: "ok" } },
  });
  if (doctorExpected) {
    expectDoctorDiagnostics();
  }
}

function reportedResult(lane: Lane): unknown {
  return lane === "resume" || lane === "repair"
    ? vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]
    : mocks.print.mock.lastCall?.[0];
}

function seedInterruptedPostCoreRun(): UpdateRunRecord {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 2 * ABANDONED_UPDATE_RUN_MS);
  try {
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    return recordUpdateRunPhase(run.runId, "verifying", {
      step: { step: "post-update verification", status: "in_progress" },
    });
  } finally {
    clock.mockRestore();
  }
}

function expectRecoveredRun(run: UpdateRunRecord | undefined): void {
  expect(run).toMatchObject({
    status: "failed",
    reason: "abandoned",
    steps: expect.arrayContaining([
      expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
    ]),
  });
}

async function prepareIncompleteSourceRuntime() {
  await runExec("git", ["init", "--quiet", state.root], { timeoutMs: 15_000 });
  await fs.symlink(
    fileURLToPath(new URL("../../../scripts", import.meta.url)),
    state.path("scripts"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const files = {
    "tsconfig.json": JSON.stringify({
      extends: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
    }),
    "package.json": JSON.stringify({
      name: "openclaw",
      version: VERSION,
      type: "module",
      exports: { "./plugin-sdk/demo": "./dist/plugin-sdk/demo.js" },
    }),
    "dist/plugin-sdk/demo.js": "export const generation = 'candidate';\n",
    "dist/extensions/demo/index.js": "export const generation = 'candidate';\n",
    "dist/extensions/demo/package.json": JSON.stringify({
      name: "demo",
      type: "module",
      generation: "candidate",
    }),
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = state.path(relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  stageBundledPluginRuntime({ repoRoot: state.root });
  const aliasRoot = state.path("dist/extensions/node_modules/openclaw");
  const runtimeEntry = state.path("dist-runtime/extensions/demo/index.js");
  const runtimeMetadata = state.path("dist-runtime/extensions/demo/package.json");
  await fs.unlink(runtimeEntry);
  await fs.writeFile(runtimeMetadata, '{"name":"demo","generation":"stale"}\n');
  return { aliasRoot, runtimeEntry, runtimeMetadata, aliasBefore: await fs.stat(aliasRoot) };
}

describe("update orchestration lifecycle ownership", () => {
  it.each([
    { shape: "legacy-mjs", version: "2026.4.27", source: undefined, failure: undefined },
    {
      shape: "legacy-mts",
      version: VERSION,
      source:
        "export function stageBundledPluginRuntime() { throw new Error('legacy stager ran'); }",
      failure: undefined,
    },
    {
      shape: "malformed-prepare",
      version: VERSION,
      source: "export const prepareBundledPluginRuntime = 1;",
      failure: /cannot complete its runtime artifacts/,
    },
    {
      shape: "missing-dependency",
      version: VERSION,
      source: "import './missing-dependency.mjs'; export function prepareBundledPluginRuntime() {}",
      failure: /missing-dependency/,
    },
    {
      shape: "missing-ownership",
      version: VERSION,
      source:
        "export function prepareBundledPluginRuntime() { throw new Error('stager ran without ownership'); }",
      failure: /dist-artifact-ownership/,
    },
  ])(
    "converges target-owned source completion contracts: $shape",
    async ({ version, source, failure }) => {
      await writeScenario("current-process");
      const { runtimeEntry } = await prepareIncompleteSourceRuntime();
      stageBundledPluginRuntime({ repoRoot: state.root });
      const original = await fs.stat(runtimeEntry);
      const packageJson = JSON.parse(await fs.readFile(state.path("package.json"), "utf8"));
      await fs.writeFile(state.path("package.json"), JSON.stringify({ ...packageJson, version }));
      await fs.unlink(state.path("scripts"));
      await fs.mkdir(state.path("scripts"));
      await fs.writeFile(
        state.path("scripts/stage-bundled-plugin-runtime.mjs"),
        "throw new Error('legacy CLI shim imported');",
      );
      if (source) {
        await fs.writeFile(state.path("scripts/stage-bundled-plugin-runtime.mts"), source);
      }
      mocks.plugins.mockResolvedValue({ ...pluginResult, changed: false });
      const current = version === VERSION;
      const result = convergeUpdatePlugins({
        coreAlreadyCurrent: current,
        result: {
          status: current ? "skipped" : "ok",
          mode: "git",
          root: state.root,
          before: { version: VERSION },
          after: { version },
          steps: [],
          durationMs: 1,
        },
        root: state.root,
        installKindChanged: false,
        configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
        requestedChannel: null,
        storedChannel: "stable",
        channel: "stable",
        downgradeRisk: !current,
        opts: { json: true, yes: true },
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 15_000,
      });
      if (failure) {
        await expect(result).rejects.toThrow(failure);
        expect(mocks.plugins).not.toHaveBeenCalled();
      } else {
        expect((await result).resultWithPostUpdate.status).toBe(current ? "skipped" : "ok");
        expect(mocks.plugins).toHaveBeenCalledOnce();
      }
      expect(mocks.publication).not.toHaveBeenCalled();
      expect(await fs.stat(runtimeEntry)).toMatchObject({
        ino: original.ino,
        mtimeMs: original.mtimeMs,
      });
    },
  );

  it.each(["resume", "repair"] as const)(
    "%s completes missing source artifacts before consumers and leaves an exact online retry untouched",
    async (lane) => {
      await writeScenario(lane, { runtimeRoot: state.root });
      const { aliasRoot, runtimeEntry, runtimeMetadata, aliasBefore } =
        await prepareIncompleteSourceRuntime();
      mocks.plugins.mockImplementation(async () => {
        await runExec(process.execPath, [entrypoint, "runtime-proof"], { timeoutMs: 15_000 });
        return pluginResult;
      });

      await invoke(lane);
      expectSuccess(lane);
      expect(mocks.publication).toHaveBeenCalledOnce();
      expect((await fs.stat(aliasRoot)).ino).toBe(aliasBefore.ino);
      expect(JSON.parse(await fs.readFile(runtimeMetadata, "utf8")).generation).toBe("candidate");
      const firstEvents = await events();
      expect(firstEvents).toContain("runtime-proof:runtime-proof");
      expect(firstEvents.indexOf("runtime-proof:doctor")).toBeGreaterThan(-1);
      expect(firstEvents.indexOf("runtime-proof:doctor")).toBeLessThan(
        firstEvents.indexOf("pre-attempt"),
      );

      const beforeRetry = await fs.stat(runtimeEntry);
      await fs.writeFile(state.statePath("events.jsonl"), "");
      mocks.publication.mockImplementationOnce(async () => {
        throw new Error("A running Gateway cannot publish changed artifacts.");
      });
      await invoke(lane);
      expectSuccess(lane);
      expect(await events()).toEqual(firstEvents);
      expect(mocks.publication).toHaveBeenCalledOnce();
      expect(await fs.stat(runtimeEntry)).toMatchObject({
        ino: beforeRetry.ino,
        mtimeMs: beforeRetry.mtimeMs,
      });
      expect((await fs.stat(aliasRoot)).ino).toBe(aliasBefore.ino);
    },
  );

  it("resume preserves publication failure details when staging cleanup also fails", async () => {
    await writeScenario("resume", { runtimeRoot: state.root });
    await prepareIncompleteSourceRuntime();
    const resultPath = state.path("post-core-result.json");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
    mocks.publication.mockRejectedValueOnce(new Error("publication authority revoked"));
    const remove = fsSync.rmSync.bind(fsSync);
    const cleanup = vi.spyOn(fsSync, "rmSync").mockImplementation((target, options) => {
      if (String(target).startsWith(state.root) && String(target).includes(".openclaw-runtime-")) {
        throw new Error("staging cleanup unavailable");
      }
      return remove(target, options);
    });
    try {
      await expect(invoke("resume")).rejects.toThrow(
        "Runtime completion and staging cleanup failed",
      );
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      expect(result.status).toBe("failed");
      expect(result.error).toContain("publication authority revoked");
      expect(result.error).toContain("staging cleanup unavailable");
      expect(mocks.plugins).not.toHaveBeenCalled();
    } finally {
      cleanup.mockRestore();
    }
  });

  it.each(["resume", "fresh-process", "current-process", "repair"] as const)(
    "%s releases plugin ownership for fresh doctor without delegating Gateway activation",
    async (lane) => {
      const recovery = lane === "repair" ? seedInterruptedPostCoreRun() : undefined;
      let recoveredAtOutput: UpdateRunRecord | undefined;
      if (recovery) {
        vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
          recoveredAtOutput = getUpdateRun(recovery.runId);
        });
      }
      await writeScenario(lane, {
        hostVersion: lane === "current-process" ? "1.0.0" : undefined,
      });
      if (lane === "current-process") {
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", "1");
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR", "1");
      }
      mocks.plugins.mockImplementationOnce(async () => {
        const result = await runExec(process.execPath, [entrypoint, "probe"], {
          timeoutMs: 15_000,
        });
        expect(result.stdout).toBe("excluded");
        return pluginResult;
      });
      await invoke(lane, recovery ? [recovery.runId] : []);
      expectSuccess(lane);
      if (recovery) {
        expectRecoveredRun(recoveredAtOutput);
        expect(reportedResult(lane)).toMatchObject({ reconciledRuns: [recovery.runId] });
        expectRecoveredRun(getUpdateRun(recovery.runId));
        expect(listUpdateRuns({ active: true })).toEqual([]);
        expect(listUpdateRuns({ limit: 1 })[0]?.origin.driver?.pid).toBe(process.pid);
      }
      expect(process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe(
        lane === "current-process" ? "1" : undefined,
      );
      expect(await events()).toEqual([
        ...(lane === "repair" || lane === "resume" ? ["pre-attempt", "pre-acquired"] : []),
        ...(lane === "fresh-process" ? ["packages-acquired", "packages-released"] : []),
        "post-attempt",
        "post-acquired",
        "validate",
        "readiness",
      ]);
      if (lane === "current-process") {
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({ shouldRestart: false }),
        );
      }
      if (lane === "fresh-process") {
        expect(mocks.plugins).not.toHaveBeenCalled();
      } else {
        expect(mocks.plugins).toHaveBeenCalledOnce();
      }
      const after = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
      expect(after.stdout).toBe("acquired");
    },
  );

  it.each(["current-process", "repair"] as const)(
    "%s reloads config and records after a competing writer commits",
    async (lane) => {
      await writePersistedInstalledPluginIndexInstallRecords({ old: { source: "path" } });
      expect(await loadInstalledPluginIndexInstallRecords()).toHaveProperty("old");
      const writerRecords: Record<string, PluginInstallRecord> = {
        current: { source: "path", sourcePath: state.path("current") },
      };
      await writeScenario(lane, {
        writerConfig: {
          plugins: { enabled: false },
          update: { channel: "beta" },
          gateway: { port: 19002 },
        },
        writerRecords,
      });
      const acquired = createDeferred();
      const completed = createDeferred();
      const child = spawn(process.execPath, [entrypoint, "writer"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      if (!child.stderr) {
        throw new Error("writer stderr pipe was not created");
      }
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("message", () => acquired.resolve());
      child.once("error", (error) => {
        acquired.reject(error);
        completed.reject(error);
      });
      child.once("close", (code) => {
        if (code === 0) {
          completed.resolve();
        } else {
          const error = new Error(`writer exited ${code}: ${stderr}`);
          acquired.reject(error);
          completed.reject(error);
        }
      });
      void completed.promise.catch(() => {});
      const beforeDoctor = createDeferred();
      if (lane === "repair") {
        // Enter with the old config, then release the foreign writer before the
        // fixture's zero-retry Doctor acquisition. This still detects a parent
        // retaining its own lease without racing the deliberately competing one.
        mocks.entrypoint.mockImplementationOnce(async () => {
          beforeDoctor.resolve();
          await completed.promise;
          return entrypoint;
        });
      }
      try {
        await acquired.promise;
        const update = invoke(lane);
        void update.catch(() => {});
        if (lane === "repair") {
          await Promise.race([beforeDoctor.promise, update]);
        }
        child.send("commit");
        await completed.promise;
        await update;
        expectSuccess(lane);
        expect(mocks.plugins).toHaveBeenCalledWith(
          expect.objectContaining({
            configSnapshot: expect.objectContaining({
              config: expect.objectContaining({
                gateway: expect.objectContaining({ port: 19002 }),
              }),
            }),
            pluginInstallRecords: writerRecords,
          }),
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await completed.promise.catch(() => {});
      }
    },
  );

  it.each([false, true])(
    "resume reads the parent migration owner's committed generation (empty=%s)",
    async (empty) => {
      const old = { old: { source: "path" as const } };
      await writePersistedInstalledPluginIndexInstallRecords(old);
      expect(await loadInstalledPluginIndexInstallRecords()).toEqual(old);
      const recordsPath = await state.writeJson("forwarded.json", old);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH", recordsPath);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS", String(Date.now()));
      const current: Record<string, PluginInstallRecord> = empty
        ? {}
        : { current: { source: "path" } };
      await state.writeConfig({ plugins: { enabled: false }, gateway: { port: 19003 } });
      await writePersistedInstalledPluginIndexInstallRecords(current);
      await writeScenario("resume");
      await invoke("resume");
      expectSuccess("resume");
      expect(mocks.plugins).toHaveBeenCalledWith(
        expect.objectContaining({
          configSnapshot: expect.objectContaining({
            config: expect.objectContaining({ gateway: expect.objectContaining({ port: 19003 }) }),
          }),
          pluginInstallRecords: current,
        }),
      );
      expect(await events()).toEqual([
        "pre-attempt",
        "pre-acquired",
        "post-attempt",
        "post-acquired",
        "validate",
        "readiness",
      ]);
    },
  );

  it.each(["resume", "fresh-process", "current-process", "repair"] as const)(
    "%s does not run a final doctor when no plugins changed",
    async (lane) => {
      await writeScenario(lane, { pluginUpdate: { ...pluginResult, changed: false } });
      mocks.plugins.mockResolvedValueOnce({ ...pluginResult, changed: false });
      await invoke(lane);
      expectSuccess(lane, lane === "repair" || lane === "resume");
      expect(await events()).toEqual([
        ...(lane === "repair" || lane === "resume" ? ["pre-attempt", "pre-acquired"] : []),
        ...(lane === "fresh-process" ? ["packages-acquired", "packages-released"] : []),
        "validate",
        "readiness",
      ]);
    },
  );

  it.each(["fresh-process", "current-process", "repair"] as const)(
    "%s retains strict fresh validation after releasing the lease",
    async (lane) => {
      const recovery = lane === "repair" ? seedInterruptedPostCoreRun() : undefined;
      await writeScenario(lane, { invalidConfig: true });
      await invokeReportedFailure(lane, recovery ? [recovery.runId] : []);
      if (recovery) {
        expect(getUpdateRun(recovery.runId)).toEqual(recovery);
      }
      expect(reportedResult(lane)).toMatchObject({
        status: "error",
        postUpdate: { plugins: { reason: "post-plugin-doctor-invalid-config" } },
      });
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(await events()).toContain("post-acquired");
      expect((await events()).at(-1)).toBe("validate");
    },
  );

  it("repair persists a requested channel before its fresh doctor and retains timings", async () => {
    await writeScenario("repair", { preDoctorChannel: "beta" });
    await updateFinalizeCommand({
      channel: "beta",
      json: true,
      yes: true,
      restart: false,
      deferCompletionCache: true,
    });
    expectSuccess("repair");
    expect(await events()).toContain("pre-acquired");
    expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]).toMatchObject({
      channel: "beta",
      restart: false,
      phaseTimings: [
        "preflight",
        "targetConfigValidation",
        "configSnapshot",
        "doctor",
        "plugins",
        "targetConfigConvergence",
        "completionCache",
      ].map((phase) =>
        expect.objectContaining({
          phase,
          outcome: phase === "completionCache" ? "deferred" : "completed",
        }),
      ),
    });
  });

  it("repair propagates its pre-plugin doctor failure before mutation", async () => {
    const recovery = seedInterruptedPostCoreRun();
    await writeScenario("repair", { failDoctor: "pre" });
    await expect(invoke("repair", [recovery.runId])).rejects.toThrow("doctor fixture failure");
    expect(getUpdateRun(recovery.runId)).toEqual(recovery);
    expect(mocks.plugins).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expectDoctorDiagnostics();
    expect(await events()).toEqual(["pre-attempt", "pre-acquired"]);
  });

  it("repair reconciles captured runs before publishing successful convergence with warnings", async () => {
    const recovery = seedInterruptedPostCoreRun();
    const warning: ProducedPluginUpdateResult = {
      ...pluginResult,
      status: "warning",
      changed: false,
    };
    await writeScenario("repair", { pluginUpdate: warning });
    mocks.plugins.mockResolvedValueOnce(warning);
    let recoveredAtOutput: UpdateRunRecord | undefined;
    vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
      recoveredAtOutput = getUpdateRun(recovery.runId);
    });

    await invoke("repair", [recovery.runId]);

    expect(reportedResult("repair")).toMatchObject({
      status: "warning",
      reconciledRuns: [recovery.runId],
    });
    expectRecoveredRun(recoveredAtOutput);
    expect(listUpdateRuns({ active: true })).toEqual([]);
  });

  it("repair withholds success when a captured updater advances during convergence", async () => {
    const recovery = seedInterruptedPostCoreRun();
    await writeScenario("repair", { pluginUpdate: { ...pluginResult, changed: false } });
    mocks.plugins.mockImplementationOnce(async () => {
      recordUpdateRunStep(recovery.runId, {
        step: "build",
        status: "in_progress",
        startedAtMs: Date.now(),
      });
      return { ...pluginResult, changed: false };
    });

    await expect(invoke("repair", [recovery.runId])).rejects.toThrow("An update resumed");

    expect(getUpdateRun(recovery.runId)).toMatchObject({ status: "running", reason: null });
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("resume reports a plugin exception after releasing its lease", async () => {
    await writeScenario("resume");
    const resultPath = state.path("failed-post-core.json");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
    mocks.plugins.mockRejectedValueOnce(new Error("plugin fixture failure"));
    await expect(invoke("resume")).rejects.toThrow("plugin fixture failure");
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("plugin fixture failure"),
    });
    expect(result.error).not.toContain(state.root);
    const probe = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
    expect(probe.stdout).toBe("acquired");
  });

  it("resume withholds the handoff result when its first migration Doctor fails", async () => {
    await writeScenario("resume", { failDoctor: "pre" });
    const resultPath = state.path("failed-first-doctor.json");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);

    await expect(invoke("resume")).rejects.toThrow("doctor fixture failure");

    expect(mocks.plugins).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({
      status: "failed",
      error: expect.stringContaining("doctor fixture failure"),
    });
    expect(await events()).toEqual(["pre-attempt", "pre-acquired"]);
    const probe = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
    expect(probe.stdout).toBe("acquired");
  });

  it("rejects restart handling after a final doctor failure despite valid config", async () => {
    await writeScenario("current-process", { failDoctor: "post", hostVersion: "1.0.0" });
    await invokeReportedFailure("current-process");
    expect(mocks.print.mock.lastCall?.[0]).toMatchObject({
      status: "error",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      postUpdate: { plugins: { reason: "post-plugin-doctor-execution-failed" } },
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
    expectDoctorDiagnostics();
    expect(await events()).toEqual(["post-attempt", "post-acquired", "validate", "readiness"]);
  });

  it.each([
    {
      lane: "fresh-process" as const,
      failure: "finding" as const,
      reason: "post-plugin-update-readiness-failed",
    },
    {
      lane: "fresh-process" as const,
      failure: "execution" as const,
      reason: "post-plugin-update-readiness-execution-failed",
    },
    {
      lane: "current-process" as const,
      failure: "finding" as const,
      reason: "post-plugin-update-readiness-failed",
    },
    {
      lane: "current-process" as const,
      failure: "execution" as const,
      reason: "post-plugin-update-readiness-execution-failed",
    },
    {
      lane: "repair" as const,
      failure: "finding" as const,
      reason: "post-plugin-update-readiness-failed",
    },
    {
      lane: "repair" as const,
      failure: "execution" as const,
      reason: "post-plugin-update-readiness-execution-failed",
    },
  ])(
    "$lane leaves the Gateway stopped after a readiness $failure",
    async ({ lane, failure, reason }) => {
      await writeScenario(lane, {
        readinessFailure: failure,
        hostVersion: lane === "current-process" ? "1.0.0" : undefined,
      });

      await invokeReportedFailure(lane);

      expect(reportedResult(lane)).toMatchObject({
        status: "error",
        postUpdate: { plugins: { reason } },
      });
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(await events()).toEqual([
        ...(lane === "repair" ? ["pre-attempt", "pre-acquired"] : []),
        ...(lane === "fresh-process" ? ["packages-acquired", "packages-released"] : []),
        "post-attempt",
        "post-acquired",
        "validate",
        "readiness",
      ]);
    },
  );

  it.each([
    { lane: "resume", valid: true },
    { lane: "fresh-process", valid: true },
    { lane: "repair", valid: true },
    { lane: "resume", valid: false },
    { lane: "fresh-process", valid: false },
    { lane: "repair", valid: false },
  ] as const)(
    "$lane stamps only strictly valid downgrade config (valid=$valid)",
    async ({ lane, valid }) => {
      const futureVersion = "2099.1.1";
      await state.writeConfig({
        meta: { lastTouchedVersion: futureVersion },
        plugins: { enabled: false },
        update: { channel: "stable" },
        gateway: { port: valid ? 19004 : -1 },
      });
      await writeScenario(lane, { failDoctor: "post", invalidConfig: !valid });

      if (lane === "resume") {
        await invoke(lane);
      } else {
        await invokeReportedFailure(lane);
      }
      expect(reportedResult(lane)).toMatchObject({
        status: "error",
        postUpdate: {
          plugins: {
            reason: valid
              ? "post-plugin-doctor-execution-failed"
              : "post-plugin-doctor-invalid-config",
          },
        },
      });
      const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      expect(persisted.meta?.lastTouchedVersion).toBe(valid ? VERSION : futureVersion);
      expect(persisted.update?.channel).toBe("stable");
      const startupBlock = resolveFutureConfigActionBlock({
        action: "start gateway service",
        config: persisted,
        env: {},
      });
      expect(startupBlock === null).toBe(valid);
      expect(await events(), JSON.stringify(vi.mocked(defaultRuntime.error).mock.calls)).toEqual([
        ...(lane === "repair" || lane === "resume" ? ["pre-attempt", "pre-acquired"] : []),
        ...(lane === "fresh-process" ? ["packages-acquired", "packages-released"] : []),
        "post-attempt",
        "post-acquired",
        "validate",
        ...(valid ? ["readiness"] : []),
      ]);
    },
  );
});
