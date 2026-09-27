import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
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

import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import type { LeaseScenario } from "./update-command-lease.test-support.js";
import type { ProducedPluginUpdateResult } from "./update-command-plugins-internals.js";
import { finishUpdate } from "./update-command-post-update.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

export const pluginResult: ProducedPluginUpdateResult = {
  assessment: { kind: "no-payload-repair" },
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

type Lane = LeaseScenario["lane"];
export let state: OpenClawTestState;
export let entrypoint: string;

export function installUpdateLeaseHarness(): void {
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await state.cleanup();
  });
}

export async function writeScenario(
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
  if (lane === "resume") {
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", state.path("post-core-result.json"));
    await fs.writeFile(state.path("handoff.json"), JSON.stringify({ completionOwner: "parent" }));
  }
}

export async function invoke(lane: Lane, recoveryRunIds: readonly string[] = []): Promise<void> {
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
  expect(reportedResult(lane)).toMatchObject(
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
