import { resetGatewaySuspendCoordinatorForLifecycleRestart } from "../infra/gateway-suspend-coordinator.js";
import {
  resetGatewayRestartStateForInProcessRestart,
  setGatewayRestartPolicy,
  setPreRestartDeferralCheck,
} from "../infra/restart.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";

export async function resetGatewayLifecycleTestState(options: {
  preserveRuntimeBindings: boolean;
}): Promise<void> {
  await drainOpenClawAgentWriteQueuesForTest();
  // Resume held scheduling and cancel pending restart work before clearing
  // admission. Live suite servers keep their policy and active-work binding.
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayRestartStateForInProcessRestart();
  if (!options.preserveRuntimeBindings) {
    setGatewayRestartPolicy({ allowExternal: false });
    setPreRestartDeferralCheck(() => 0);
  }
  resetGatewayWorkAdmission();
}
