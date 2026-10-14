// Stable entry for service commands and recovery calls from installed update drivers.
import type {
  DaemonInstallOptions,
  DaemonLifecycleOptions,
  DaemonStatusOptions,
} from "./daemon-cli/types.js";

export { registerDaemonCli } from "./daemon-cli/register.js";
export { addGatewayServiceCommands } from "./daemon-cli/register-service-commands.js";
export type {
  DaemonInstallOptions,
  DaemonStatusOptions,
  GatewayRpcOpts,
} from "./daemon-cli/types.js";

// Finalization must not load the service/plugin graph before settling the ledger.
const loadInstallRuntime = () => import("./daemon-cli/install.js");
const loadLifecycleRuntime = () => import("./daemon-cli/lifecycle.js");
const loadStatusRuntime = () => import("./daemon-cli/status.js");
const loadLifecycleContextRuntime = () => import("./daemon-cli/lifecycle-context.js");
const loadServiceHandoffRuntime = () => import("../infra/update-managed-service-handoff.js");

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  const runtime = await loadInstallRuntime();
  return runtime.runDaemonInstall(opts);
}

export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}) {
  const runtime = await loadLifecycleRuntime();
  return runtime.runDaemonRestart(opts);
}

export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  const runtime = await loadLifecycleRuntime();
  return runtime.runDaemonStart(opts);
}

export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  const runtime = await loadLifecycleRuntime();
  return runtime.runDaemonStop(opts);
}

export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  const runtime = await loadLifecycleRuntime();
  return runtime.runDaemonUninstall(opts);
}

export async function runDaemonStatus(opts: DaemonStatusOptions) {
  const runtime = await loadStatusRuntime();
  return runtime.runDaemonStatus(opts);
}

export async function isManagedUpdateRequesterOwner(
  ...args: Parameters<
    typeof import("./daemon-cli/lifecycle-context.js").isManagedUpdateRequesterOwner
  >
) {
  const runtime = await loadLifecycleContextRuntime();
  return runtime.isManagedUpdateRequesterOwner(...args);
}

export async function waitForGatewayUpdateRecovery(
  ...args: Parameters<
    typeof import("./daemon-cli/lifecycle-context.js").waitForGatewayUpdateRecovery
  >
) {
  const runtime = await loadLifecycleContextRuntime();
  return runtime.waitForGatewayUpdateRecovery(...args);
}

// Handoff admission uses the serving runtime; terminal writes load the installed runtime afresh.
export {
  adoptUpdateRun,
  getUpdateRun,
  recordUpdateRunDiagnostic,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
export { finishDaemonUpdateRun as finishUpdateRun } from "./daemon-cli/update-run.js";

export {
  createManagedUpdateRequesterAuthority,
  prepareManagedUpdateRequesterIdentity,
} from "../infra/update-requester-authority.js";

export async function assertForegroundUpdateOrigin(
  ...args: Parameters<
    typeof import("../infra/update-managed-service-handoff.js").assertForegroundUpdateOrigin
  >
) {
  const runtime = await loadServiceHandoffRuntime();
  return runtime.assertForegroundUpdateOrigin(...args);
}
