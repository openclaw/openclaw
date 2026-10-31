import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { LockPayload, readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";

export function gatewayOwnerPayload(
  state: Pick<OpenClawTestState, "configPath" | "stateDir">,
  readNamespace: typeof readGatewayLockProcessNamespace,
): LockPayload {
  return {
    pid: process.pid,
    processNamespace: readNamespace(),
    createdAt: new Date().toISOString(),
    configPath: state.configPath,
    stateDir: state.stateDir,
    role: "gateway",
  };
}
