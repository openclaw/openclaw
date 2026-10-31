import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { TempHomeEnv } from "../test-utils/temp-home.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";
import {
  createUpdateFixtureAssertions,
  withPostCoreUpdateFixtureRun,
} from "./update-cli-shared-fixture.test-support.js";

export const readPackageVersion = vi.fn();
export const syncPluginsForUpdateChannel = vi.fn();
export const updateNpmInstalledPlugins = vi.fn();
export const loadInstalledPluginIndexInstallRecords = vi.fn();
const pathExists = vi.fn();
const spawn = vi.fn();
export const observeUpdateGatewayReadiness =
  vi.fn<typeof import("./update-cli/update-command-readiness.js").observeUpdateGatewayReadiness>();
const { defaultRuntime: runtimeCapture, resetRuntimeCapture } = createCliRuntimeCapture();
const sourceRuntimeCompletion = vi.hoisted(() =>
  vi.fn<typeof import("./update-cli/update-command-runtime.js").completeSourceUpdateRuntime>(),
);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  const { createUpdateUtf8CommandTransportFixture } =
    await import("./update-cli/update-command-transport.test-support.js");
  const transport = {
    run: vi.fn<typeof actual.runCommandWithTimeout>(),
    exec: vi.fn<typeof actual.runExec>(),
    hostCwd: process.cwd(),
    hostEnv: { ...process.env },
    npmPrefix: "",
  };
  return {
    ...actual,
    runCommandWithTimeout: transport.run,
    runExec: transport.exec,
    runUtf8CommandWithTimeout: await createUpdateUtf8CommandTransportFixture(
      transport,
      actual.runUtf8CommandWithTimeout,
    ),
  };
});
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: runtimeCapture,
}));
vi.mock("../infra/update-runner-git.js", () => ({
  updateGitCheckout: vi.fn(),
}));
// Runtime publication has its own fixture; this suite owns deferred completion and config writes.
vi.mock("./update-cli/update-command-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-cli/update-command-runtime.js")>()),
  completeSourceUpdateRuntime: sourceRuntimeCompletion,
}));
vi.mock("../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-check.js")>()),
  resolveUpdateInstallKind: vi.fn(async () => "git"),
}));
vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease: vi.fn(async () => ({
    previous: null,
    revision: 1,
  })),
}));
vi.mock("../plugins/installed-plugin-index-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-store.js")>()),
  readPersistedInstalledPluginIndex: vi.fn(async () => null),
}));
vi.mock("../plugins/installed-plugin-index-store-write.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-store-write.js")>()),
  restorePersistedInstalledPluginIndexIfCurrent: vi.fn(async () => true),
}));
vi.mock("../config/config.js", async () => {
  const { createUpdateConfigMock } = await import("./update-cli-shared-fixture.test-support.js");
  return createUpdateConfigMock();
});

vi.mock("../daemon/gateway-entrypoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/gateway-entrypoint.js")>();
  return {
    ...actual,
    resolveGatewayInstallEntrypoint: vi.fn(actual.resolveGatewayInstallEntrypoint),
  };
});

vi.mock("./update-cli/update-command-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-cli/update-command-readiness.js")>()),
  observeUpdateGatewayReadiness,
}));

vi.mock("./update-cli/update-command-post-plugin-readiness.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./update-cli/update-command-post-plugin-readiness.js")>();
  return {
    ...actual,
    applyPostPluginUpdateReadiness: vi.fn(
      async (params: Parameters<typeof actual.applyPostPluginUpdateReadiness>[0]) =>
        params.pluginUpdate,
    ),
  };
});

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  displayString: (input: string) => input,
  pathExists,
  resolveConfigDir: () => "/tmp/openclaw-config",
  sleep: vi.fn(async () => undefined),
}));

vi.mock("../plugins/official-external-install-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-install-records.js")>()),
  resolveTrustedSourceLinkedOfficialClawHubInstall: vi.fn(() => undefined),
  resolveTrustedSourceLinkedOfficialNpmInstall: vi.fn(() => undefined),
}));

vi.mock("../plugins/update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/update.js")>()),
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
}));

// mock-isolation: Deferred completion supplies convergence facts without running Doctor or plugin installs.
vi.mock("../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: vi.fn(
    async (params: { cfg: OpenClawConfig; baselineInstallRecords?: unknown }) => ({
      ...postCoreConvergenceResult(),
      config: params.cfg,
      installRecords: params.baselineInstallRecords ?? {},
    }),
  ),
}));

const {
  createUpdateCliBaseSnapshot,
  createUpdateCliConfigFixtures,
  postCoreConvergenceResult,
  stableConfig,
  stableWhatsAppConfig,
} = await import("./update-cli/update-cli-config.test-support.js");
const { writeJsonFixture } = await import("./update-cli/update-cli-package.test-support.js");
const { createTempHomeEnv } = await import("../test-utils/temp-home.js");
export const { updateGitCheckout } = await import("../infra/update-runner-git.js");
const { runExec, runCommandWithTimeout } = await import("../process/exec.js");
export { runExec };
export const { defaultRuntime, ExitError } = await import("../runtime.js");
export const { readConfigFileSnapshot, replaceConfigFile, mutateConfigFileWithRetry } =
  await import("../config/config.js");
export const { resolveGatewayInstallEntrypoint } = await import("../daemon/gateway-entrypoint.js");
export const { updateFinalizeCommand } = await import("./update-cli/update-command-finalize.js");
const { updateCommand } = await import("./update-cli/update-command.js");
const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
const shared = await import("./update-cli/shared.js");
const postCorePluginConvergence =
  await import("../commands/doctor/shared/post-core-plugin-convergence.js");
export const runPostCorePluginConvergenceSpy = vi.spyOn(
  postCorePluginConvergence,
  "runPostCorePluginConvergence",
);

export function installDeferredCompletionFixture() {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  let tempHome: TempHomeEnv | undefined;
  const createCaseDir = (prefix: string) => dirs.make(`${prefix}-`);
  const FRESH_POST_UPDATE_ENTRYPOINT = "/tmp/openclaw-updated-entry.mjs";
  const baseConfig: OpenClawConfig = {};
  const baseSnapshot = createUpdateCliBaseSnapshot(baseConfig);

  const { syncPluginCall, lastReplaceConfigCall, setupConfigMutationWithRetryMock, getLogOutput } =
    createUpdateFixtureAssertions({
      syncPluginsForUpdateChannel,
      updateNpmInstalledPlugins,
      readConfigFileSnapshot,
      mutateConfigFileWithRetry,
      replaceConfigFile,
      defaultRuntime,
    });
  const mockFileBackedPathExists = () => {
    pathExists.mockImplementation((candidate: string) =>
      fs.access(candidate).then(
        () => true,
        () => false,
      ),
    );
  };

  const { configSnapshot, mockPostDoctorSnapshot, mockNoopPostUpdatePluginConvergence } =
    createUpdateCliConfigFixtures({
      baseConfig,
      baseSnapshot,
      readConfigFileSnapshot,
      syncPluginsForUpdateChannel,
      updateNpmInstalledPlugins,
      createCaseDir,
    });

  const runPostCoreCommand = (
    options: Parameters<typeof updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) =>
    withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
        ...env,
      },
      () => withPostCoreUpdateFixtureRun(() => updateCommand(options)),
    );
  const runPostCoreUpdate = (env: NodeJS.ProcessEnv = {}) =>
    runPostCoreCommand({ yes: true, restart: false }, env);

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-deferred-completion-");
    vi.resetAllMocks();
    sourceRuntimeCompletion.mockResolvedValue({ changed: false });
    resetRuntimeCapture();
    for (const key of [
      "OPENCLAW_COMPATIBILITY_HOST_VERSION",
      "OPENCLAW_UPDATE_RUN_HANDOFF",
      "OPENCLAW_UPDATE_RUN_ID",
      "OPENCLAW_UPDATE_POST_CORE_RESULT_PATH",
      "OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.spyOn(shared, "readPackageVersion").mockImplementation(readPackageVersion);
    readPackageVersion.mockResolvedValue("1.0.0");
    vi.mocked(defaultRuntime.exit).mockImplementation(() => {});
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    // Finalization failure observes the fixture's absent Gateway without contacting the host.
    observeUpdateGatewayReadiness.mockImplementation(async ({ gatewayPort, assertCurrent }) => {
      assertCurrent?.();
      return {
        health: {
          healthy: false,
          waitOutcome: "stopped-free",
          runtime: { status: "stopped" },
          portUsage: { port: gatewayPort, status: "free", listeners: [], hints: [] },
          staleGatewayPids: [],
        },
        readyz: false,
        http: undefined,
        launchAgentRecovery: null,
      };
    });
    setupConfigMutationWithRetryMock();
    loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mockNoopPostUpdatePluginConvergence();
    const entrypoint = path.join(process.cwd(), "dist", "index.js");
    pathExists.mockImplementation(async (candidate: string) => candidate === entrypoint);
    // Child completion may invoke only Doctor and config validation.
    vi.mocked(runExec).mockImplementation(async (file, args) => {
      if (file === process.execPath && (args[1] === "doctor" || args[1] === "config")) {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected completion process: ${file}`);
    });
    vi.mocked(runCommandWithTimeout).mockRejectedValue(
      new Error("Completion must not run a core install"),
    );
    vi.mocked(updateGitCheckout).mockRejectedValue(
      new Error("Completion must not run core update"),
    );
    spawn.mockImplementation(() => {
      throw new Error("Completion must not spawn core update");
    });
  });
  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await tempHome?.restore();
  });
  return {
    runPostCoreCommand,
    postCoreConvergenceResult,
    syncPluginCall,
    getLogOutput,
    createCaseDir,
    writeJsonFixture,
    FRESH_POST_UPDATE_ENTRYPOINT,
    configSnapshot,
    stableConfig,
    mockFileBackedPathExists,
    stableWhatsAppConfig,
    mockPostDoctorSnapshot,
    runPostCoreUpdate,
    lastReplaceConfigCall,
  };
}
