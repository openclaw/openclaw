import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { resolveSqliteSchemaAssetInputs } from "../../../scripts/lib/sqlite-schema-assets.mts";
import { vitestWorkerRuntimeAssets } from "../../../scripts/lib/vitest-worker-declarations.mts";
import { readConfigFileSnapshot } from "../../config/config.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { createCompiledSdkHost } from "../../plugins/compiled-sdk-host.test-support.js";
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

export { mocks };

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.entrypoint,
}));
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./progress.js")>()),
  printResult: mocks.print,
  prepareResult:
    async (...args: Parameters<typeof import("./progress.js").printResult>) =>
    () =>
      mocks.print(...args.slice(0, 3)),
}));
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

import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import type { LeaseScenario } from "./update-command-lease.test-support.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import { finishUpdate } from "./update-command-post-update.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

export const pluginResult: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};
const leaseFixtureUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.leaseFixture);
const sealedRegistryUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.sealedRegistry);
const failureOutputUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.failureOutput);
const sourceFixture = leaseFixtureUrl.pathname.endsWith(".ts");

export type Lane = LeaseScenario["lane"] | "candidate-runtime";
export let state: OpenClawTestState;
export let entrypoint: string;

export function installUpdateLeaseHarness(): void {
  beforeEach(() => setupUpdateLeaseHarness());
  afterEach(cleanupUpdateLeaseHarness);
}

export async function setupUpdateLeaseHarness(beforeState?: () => void): Promise<void> {
  vi.clearAllMocks();
  mocks.publication.mockReset().mockImplementation(async (params, publish) => {
    params.assertCurrent();
    return await publish(async () => params.assertCurrent());
  });
  beforeState?.();
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
      import * as json5 from ${JSON.stringify(import.meta.resolve("json5"))};
      ${
        sourceFixture
          ? `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
      const loader = register({ namespace: "update-lease-fixture", tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });`
          : ""
      }
      const loadModule = ${sourceFixture ? "(url) => loader.import(url, import.meta.url)" : "(url) => import(url)"};
      const { registerSealedRuntime } = await loadModule(${JSON.stringify(sealedRegistryUrl.href)});
      registerSealedRuntime({ json5, resolveSecureTempRoot: () => ${JSON.stringify(control)} });
      const { runUpdateLeaseChild } = await loadModule(${JSON.stringify(leaseFixtureUrl.href)});
      try {
        await runUpdateLeaseChild();
      } catch (error) {
        const { formatCliFailureLines } = await loadModule(${JSON.stringify(failureOutputUrl.href)});
        for (const line of formatCliFailureLines({ title: "The CLI command failed.", error, argv: process.argv })) {
          console.error(line);
        }
        process.exitCode = 1;
      } finally {
        ${sourceFixture ? "await loader.unregister();" : ""}
      }
    `,
  );
  mocks.entrypoint.mockResolvedValue(entrypoint);
  mocks.root.mockResolvedValue(state.root);
  mocks.plugins.mockReset().mockResolvedValue(pluginResult);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
}

export async function cleanupUpdateLeaseHarness(): Promise<void> {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
}

async function prepareCandidateDoctorRuntime(): Promise<void> {
  const installed = createCompiledSdkHost(
    [
      runtimeProcessEntrypoints.updateMigratedFinalize,
      runtimeProcessEntrypoints.workerNativeLifecycle,
      runtimeProcessEntrypoints.sqliteWriterAdmission,
      runtimeProcessEntrypoints.sqliteStore,
      runtimeProcessEntrypoints.sqliteIntegrity,
      runtimeProcessEntrypoints.sqliteReadOnly,
      runtimeProcessEntrypoints.sqliteReadOnlyNativeResource,
      runtimeProcessEntrypoints.sqliteSnapshotStaging,
      runtimeProcessEntrypoints.sqliteSourceRevision,
      runtimeProcessEntrypoints.sharedStateStore,
      runtimeProcessEntrypoints.stateOwnership,
      runtimeProcessEntrypoints.stateLeaseHeartbeat,
      runtimeProcessEntrypoints.stateRead,
    ],
    () => state.root,
  );
  if (!installed) {
    throw new Error("The candidate lease fixture requires the prepared compiled worker graph.");
  }
  const worker = state.path(
    "dist",
    runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
  );
  const generation = path.resolve(
    path.dirname(
      fileURLToPath(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize)),
    ),
    "../..",
  );
  for (const asset of vitestWorkerRuntimeAssets) {
    await fs.copyFile(path.join(generation, asset), state.path(asset));
  }
  for (const asset of resolveSqliteSchemaAssetInputs()) {
    const relative = path.join("dist/assets/sqlite-schema", path.basename(asset));
    await fs.mkdir(path.dirname(state.path(relative)), { recursive: true });
    await fs.copyFile(path.join(generation, relative), state.path(relative));
  }
  const preserved = path.join(generation, "dist/legacy-finalizer");
  // The preserved graph can contain embedded dependencies; keep it beside the
  // SDK host rather than copying over that host's node_modules junction.
  await fs.cp(preserved, state.path("legacy-finalizer"), { recursive: true });
  // Consume the real delegated grant and retain its native owner. Only the Doctor
  // health body uses this fixture's existing lease probes and intentional failures.
  await fs.writeFile(
    worker,
    `
    import {registerHooks} from 'node:module';
    const health = new URL('../../legacy-finalizer/src/flows/doctor-health.js',import.meta.url).href;
    registerHooks({load(url,context,nextLoad) {
      return url !== health ? nextLoad(url,context) : {
        format:'module',shortCircuit:true,source:
          'export * from '+JSON.stringify(url+'?fixture-original')+';\\n'+
          'export async function runDoctorHealthFlow(runtime,options,authority) {'+
          'authority.assertCurrent(); const argv=process.argv;'+
          'try { process.argv=[...argv.slice(0,2),"doctor","--repair","--non-interactive",'+
          '...(options.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),'+
          '...(options.yes ? ["--yes"] : [])]; await import('+${JSON.stringify(JSON.stringify(pathToFileURL(entrypoint).href))}+') }'+
          'finally {process.argv=argv} authority.assertCurrent(); }'
      };
    }});
    await import('../../legacy-finalizer/src/infra/update-migrated-finalize.worker.js');
  `,
  );
}

export async function writeScenario(
  lane: Lane,
  scenario: Omit<LeaseScenario, "lane"> = {},
): Promise<void> {
  if (lane === "candidate-runtime") {
    await prepareCandidateDoctorRuntime();
  }
  // Fresh-process fixtures must advertise a runtime supporting continuation;
  // legacy targets intentionally exercise the current-process fallback.
  await fs.writeFile(
    state.path("package.json"),
    JSON.stringify({ version: lane === "fresh-process" ? VERSION : "1.0.0" }),
  );
  await state.writeJson("scenario.json", {
    pluginUpdate: pluginResult,
    ...scenario,
    // Both inline paths retain fresh Doctor, but must never invoke the fixture's post-core role.
    lane: lane === "candidate-runtime" ? "current-process" : lane,
  });
  if (lane === "resume") {
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", state.path("post-core-result.json"));
    await fs.writeFile(state.path("handoff.json"), JSON.stringify({ completionOwner: "parent" }));
  }
}

export async function invoke(
  lane: Lane,
  recoveryRunIds: readonly string[] = [],
  startedAt = Date.now(),
): Promise<void> {
  if (lane === "resume") {
    const env = { ...process.env };
    const { runId } = createUpdateRun(
      { trigger: "cli", runId: env.OPENCLAW_UPDATE_RUN_ID?.trim() || undefined },
      { env },
    );
    return withUpdateCommandExecutor(runId, async (executor) => {
      const executorFence = await executor.enter(state.root);
      return resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: { json: true, yes: true, run: { runId, env, executorFence } },
        timeoutMs: 15_000,
      });
    });
  }
  if (lane === "repair") {
    return updateFinalizeCommand(
      {
        json: true,
        yes: true,
        timeout: "15",
        deferCompletionCache: true,
      },
      recoveryRunIds,
    );
  }
  const env = { ...process.env };
  const { runId } = createUpdateRun({ trigger: "cli" }, { env });
  await withUpdateCommandExecutor(runId, async (executor) => {
    const executorFence = await executor.enter(state.root);
    await finishUpdate(
      {
        mutationStarted: true,
        result: {
          status: "ok",
          mode: "npm",
          root: state.root,
          before: {
            version: lane === "fresh-process" || lane === "candidate-runtime" ? "0.9.0" : "2.0.0",
          },
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
        downgradeRisk: lane !== "fresh-process" && lane !== "candidate-runtime",
        shouldRestart: false,
        opts: { json: true, yes: true, run: { runId, env, executorFence } },
        ownedManagedUpdateEnv: { ...process.env },
        controlPlaneUpdateSentinelMeta: null,
        preUpdatePluginInstallRecords: {
          stale: { source: "path", sourcePath: state.path("stale") },
        },
        startedAt,
        updateStepTimeoutMs: 15_000,
      },
      { candidateRuntime: lane === "candidate-runtime" },
    );
  });
}

export async function events(): Promise<string[]> {
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

export function expectDoctorDiagnostics(): void {
  expect(defaultRuntime.log).not.toHaveBeenCalledWith(expect.stringContaining("doctor fixture"));
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("doctor fixture output"),
  );
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("doctor fixture diagnostic"),
  );
}

export function expectSuccess(lane: Lane, doctorExpected = true): void {
  expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  const result = reportedResult(lane);
  expect(result, JSON.stringify(result, null, 2)).toMatchObject(
    lane === "resume"
      ? { status: "ok" }
      : { status: "ok", postUpdate: { plugins: { status: "ok" } } },
  );
  if (doctorExpected) {
    expectDoctorDiagnostics();
  }
}

export function reportedResult(lane: Lane): unknown {
  if (lane === "resume") {
    return JSON.parse(
      fsSync.readFileSync(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH!, "utf8"),
    );
  }
  return lane === "repair"
    ? vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]
    : mocks.print.mock.lastCall?.[0];
}
