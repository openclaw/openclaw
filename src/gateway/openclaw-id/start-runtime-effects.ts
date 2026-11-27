import type { GatewayRequestContext } from "../server-methods/types.js";
import type { GatewayClientRegistry } from "../server/client-registry.js";
import type { OpenClawIdService } from "./service.js";

export function startOpenClawIdRuntimeEffects({
  service,
  clients,
  context,
  log,
}: {
  service: OpenClawIdService;
  clients: GatewayClientRegistry;
  context: GatewayRequestContext;
  log: { warn: (message: string) => void };
}): void {
  service.bindEffects(async () => {
    const [{ createOpenClawIdRemovalEffects }, { createOpenClawIdMemberActivity }] =
      await Promise.all([import("./removal-effects.js"), import("./member-activity.js")]);
    return {
      ...createOpenClawIdRemovalEffects({
        clients: () => clients.authorityClients,
        context: () => context,
        log,
      }),
      describeActivity: createOpenClawIdMemberActivity({ clients: () => clients }).describe,
    };
  });
  void service
    .reconcileRuntimePolicy()
    .catch((error: unknown) => log.warn(`openclaw-id: start failed: ${String(error)}`));
}
