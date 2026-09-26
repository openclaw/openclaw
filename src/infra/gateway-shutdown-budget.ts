export {
  GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
  GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  isRespawnedByLauncher,
  LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  resolveLauncherStopTimeoutMs,
  resolveShutdownReserveMs,
  resolveSupervisorExitMarginMs,
} from "../../gateway-shutdown-budget.mjs";
