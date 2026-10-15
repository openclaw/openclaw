// Stable entry for service commands and recovery calls from installed update drivers.
import { createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";

export { registerDaemonCli } from "./daemon-cli/register.js";
export { addGatewayServiceCommands } from "./daemon-cli/register-service-commands.js";
export type {
  DaemonInstallOptions,
  DaemonStatusOptions,
  GatewayRpcOpts,
} from "./daemon-cli/types.js";

// Finalization must not load the service/plugin graph before settling the ledger.
const install = createLazyRuntimeMethodBinder(() => import("./daemon-cli/install.js"));
const lifecycle = createLazyRuntimeMethodBinder(() => import("./daemon-cli/lifecycle.js"));
const status = createLazyRuntimeMethodBinder(() => import("./daemon-cli/status.js"));
const lifecycleContext = createLazyRuntimeMethodBinder(
  () => import("./daemon-cli/lifecycle-context.js"),
);
const serviceHandoff = createLazyRuntimeMethodBinder(
  () => import("../infra/update-managed-service-handoff.js"),
);

export const runDaemonInstall = install((runtime) => runtime.runDaemonInstall);
export const runDaemonRestart = lifecycle((runtime) => runtime.runDaemonRestart);
export const runDaemonStart = lifecycle((runtime) => runtime.runDaemonStart);
export const runDaemonStop = lifecycle((runtime) => runtime.runDaemonStop);
export const runDaemonUninstall = lifecycle((runtime) => runtime.runDaemonUninstall);
export const runDaemonStatus = status((runtime) => runtime.runDaemonStatus);
export const isManagedUpdateRequesterOwner = lifecycleContext(
  (runtime) => runtime.isManagedUpdateRequesterOwner,
);
export const waitForGatewayUpdateRecovery = lifecycleContext(
  (runtime) => runtime.waitForGatewayUpdateRecovery,
);

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

export const assertForegroundUpdateOrigin = serviceHandoff(
  (runtime) => runtime.assertForegroundUpdateOrigin,
);
