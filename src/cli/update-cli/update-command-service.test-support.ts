import { recoverInstalledLaunchAgentAfterUpdate } from "./update-command-launch-agent-recovery.js";
import {
  formatPostUpdateGatewayRecoveryInstructions,
  recoverLaunchAgentAndRecheckGatewayHealth,
} from "./update-command-service-recovery.js";

export const testing = {
  formatPostUpdateGatewayRecoveryInstructions,
  recoverInstalledLaunchAgentAfterUpdate,
  recoverLaunchAgentAndRecheckGatewayHealth,
};
