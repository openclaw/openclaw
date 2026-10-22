import type { ApplicationContext } from "../app/context.ts";
import type { SidebarSessionMutationScope } from "./app-sidebar-session-types.ts";

export function captureSessionMutationScope(
  context: ApplicationContext | undefined,
  options: Pick<SidebarSessionMutationScope, "epoch" | "allowDeferred" | "selectedAgentId"> & {
    signal: AbortSignal;
  },
): (SidebarSessionMutationScope & { signal: AbortSignal }) | null {
  const gateway = context?.gateway;
  const client = gateway?.snapshot.client;
  if (
    !context ||
    !gateway ||
    !client ||
    gateway.snapshot.phase === "stopped" ||
    (gateway.snapshot.phase !== "connected" &&
      (!options.allowDeferred || !gateway.snapshot.hello || client.offlineRecoveryRetired))
  ) {
    return null;
  }
  return { ...options, context, gateway, sessions: context.sessions, client };
}

export function isSessionMutationScopeCurrent(
  context: ApplicationContext | undefined,
  scope: SidebarSessionMutationScope,
  currentEpoch?: number,
): boolean {
  const gateway = context?.gateway;
  return (
    (currentEpoch === undefined || currentEpoch === scope.epoch) &&
    context === scope.context &&
    gateway === scope.gateway &&
    context.sessions === scope.sessions &&
    (gateway.snapshot.phase === "connected" ||
      (scope.allowDeferred === true &&
        gateway.snapshot.phase !== "stopped" &&
        Boolean(gateway.snapshot.hello) &&
        !scope.client.offlineRecoveryRetired)) &&
    gateway.snapshot.client === scope.client
  );
}
