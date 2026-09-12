export const GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON = "runtime.generation.changed";

export function requiresFreshGatewayProcess(reason: string | undefined): boolean {
  return (
    reason === "update.run" ||
    reason === "update.auto" ||
    reason === GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON
  );
}
