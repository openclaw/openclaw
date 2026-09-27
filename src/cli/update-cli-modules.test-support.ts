import { vi } from "vitest";
import { commandTransport } from "./update-cli-mocks.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const { createUpdateStateProfileInitializer, mockUpdateStateSnapshotWorker } =
  await import("./update-cli-state-snapshot.test-support.js");
const { updateGitCheckout } = await import("../infra/update-runner-git.js");
const { createUpdateRun, getUpdateRun, listUpdateRuns } =
  await import("../infra/update-run-ledger.js");
const { closeOpenClawStateDatabaseAsync, closeOpenClawStateDatabaseForTest } =
  await import("../state/openclaw-state-db.js");
// Real recovery dependencies need the initialized runtime and child-process mocks.
const { runUpdateFailureTriage } = await import("../infra/update-triage.js");
const { resolveOpenClawPackageRoot, resolveOpenClawPackageRootSync } =
  await import("../infra/openclaw-root.js");
const { resolveGatewayInstallEntrypoint } = await import("../daemon/gateway-entrypoint.js");
const {
  mutateConfigFileWithRetry,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
  replaceConfigFile,
} = await import("../config/config.js");
const {
  checkUpdateStatus,
  fetchNpmTagVersion,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
  resolveUpdateInstallKind,
  resolveUpdateInstallIdentity,
} = await import("../infra/update-check.js");
const { fetchNpmPackageTargetStatus } = await import("../infra/update-check-package-target.js");
const { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } =
  await import("../infra/update-control-plane-sentinel.js");
const { runExec, runUtf8CommandWithTimeout } = await import("../process/exec.js");
const doctorChild = await import("./update-cli/update-command-doctor-child.js");
const runCommandWithTimeout: typeof import("../process/exec.js").runCommandWithTimeout =
  commandTransport.run;
const { runDaemonRestart, runDaemonInstall } = await import("./daemon-cli.js");
const { doctorCommand } = await import("../commands/doctor.js");
const { defaultRuntime, ExitError } = await import("../runtime.js");
const postCorePluginConvergence =
  await import("../commands/doctor/shared/post-core-plugin-convergence.js");
const { completePostCorePluginUpdate } =
  await import("./update-cli/update-command-fresh-doctor.js");
const { continuePostCoreUpdateInFreshProcess } =
  await import("./update-cli/update-command-post-core.js");
const runPostCorePluginConvergenceSpy = vi.spyOn(
  postCorePluginConvergence,
  "runPostCorePluginConvergence",
);
const { registerUpdateCli } = await import("./update-cli.js");
const { updateCommand: runUpdateCommand } = await import("./update-cli/update-command.js");
const {
  invokeUpdateCli: runUpdateCli,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  devTargetRefusalCases,
  expectGitMetadataPreview,
  expectPluginCapabilityRetryNotice,
  expectUpdateFailureReport,
  expectDelegatedPluginDoctorInput,
  expectSelectorTriageFailure,
} = await import("./update-cli-invocation.test-support.js");

// Existing scenarios pin the installed admission contract. Candidate-admission
// scenarios exercise auto mode through the same real command and transport.
const updateCommand: typeof runUpdateCommand = (options) =>
  runUpdateCommand({ admission: "installed", ...options });
const invokeUpdateCli: typeof runUpdateCli = (options) =>
  runUpdateCli({ admission: "installed", ...options });

const { updateFinalizeCommand } = await import("./update-cli/update-command-finalize.js");
const { updateStatusCommand } = await import("./update-cli/status.js");
const { updateWizardCommand } = await import("./update-cli/wizard.js");
const updateCliShared = await import("./update-cli/shared.js");
const { resolveGitInstallDir } = updateCliShared;
const { clearRestartSentinelIfRevision, readRestartSentinel } =
  await import("../infra/restart-sentinel.js");

export {
  checkUpdateStatus,
  clearRestartSentinelIfRevision,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  completePostCorePluginUpdate,
  continuePostCoreUpdateInFreshProcess,
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  createUpdateRun,
  createUpdateStateProfileInitializer,
  defaultRuntime,
  devTargetRefusalCases,
  doctorChild,
  doctorCommand,
  ExitError,
  expectDelegatedPluginDoctorInput,
  expectGitMetadataPreview,
  expectPluginCapabilityRetryNotice,
  expectSelectorTriageFailure,
  expectUpdateFailureReport,
  fetchNpmPackageTargetStatus,
  fetchNpmTagVersion,
  getUpdateRun,
  invokeUpdateCli,
  listUpdateRuns,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  mockUpdateStateSnapshotWorker,
  mutateConfigFileWithRetry,
  readConfigFileSnapshot,
  readRestartSentinel,
  readSourceConfigBestEffort,
  registerUpdateCli,
  replaceConfigFile,
  resolveExtendedStablePackage,
  resolveGatewayInstallEntrypoint,
  resolveGitInstallDir,
  resolveNpmChannelTag,
  resolveOpenClawPackageRoot,
  resolveOpenClawPackageRootSync,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
  runCommandWithTimeout,
  runDaemonInstall,
  runDaemonRestart,
  runExec,
  runPostCorePluginConvergenceSpy,
  runUpdateFailureTriage,
  runUtf8CommandWithTimeout,
  updateCliShared,
  updateCommand,
  updateFinalizeCommand,
  updateGitCheckout,
  updateStatusCommand,
  updateWizardCommand,
};
