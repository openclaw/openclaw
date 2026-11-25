import { resolveSupervisorExitMarginMs } from "../../src/infra/gateway-shutdown-budget.js";

export const GATEWAY_RESTART_TEST_STOP_MS = 46_000;
const exitMarginMs = resolveSupervisorExitMarginMs(GATEWAY_RESTART_TEST_STOP_MS);
export const GATEWAY_RESTART_TEST_SHUTDOWN_MS = GATEWAY_RESTART_TEST_STOP_MS - exitMarginMs;
// Allow the Gateway watchdog to exit, while retaining tree cleanup before the fixture deadline.
export const GATEWAY_RESTART_TEST_KILL_MS = GATEWAY_RESTART_TEST_STOP_MS - exitMarginMs / 2;
