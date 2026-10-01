import { recoverInstalledLaunchAgentAfterUpdate } from "./update-command-launch-agent-recovery.js";
import {
  formatPostUpdateGatewayRecoveryInstructions,
  recoverLaunchAgentAndRecheckGatewayHealth,
} from "./update-command-service-recovery.js";
import { hasLoadedLaunchdKeepAliveSupervisor } from "./update-command-supervisor.js";

export const testing = {
  formatPostUpdateGatewayRecoveryInstructions,
  recoverInstalledLaunchAgentAfterUpdate,
  recoverLaunchAgentAndRecheckGatewayHealth,
  hasLoadedLaunchdKeepAliveSupervisor,
};
