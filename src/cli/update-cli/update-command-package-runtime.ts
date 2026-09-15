import { resolveNodeRunner } from "./shared.js";
import {
  gatewayServiceCommandUsesRoot,
  resolvePackageRuntimePreflight,
} from "./update-command-service-plan.js";

export async function resolveManagedPackageRuntimePreflight(
  params: Pick<
    Parameters<typeof resolvePackageRuntimePreflight>[0],
    "target" | "timeoutMs" | "nodeRunner"
  > & { root: string; shouldRestart: boolean },
) {
  // Changing runners is safe only when this update owns and will rewrite the
  // service; otherwise the unchanged unit could still restart on the stale Node.
  const canRefreshManagedServiceNode =
    params.shouldRestart &&
    params.nodeRunner !== undefined &&
    (await gatewayServiceCommandUsesRoot({ root: params.root })) === true;
  return resolvePackageRuntimePreflight({
    target: params.target,
    timeoutMs: params.timeoutMs,
    nodeRunner: params.nodeRunner,
    fallbackNodeRunner: canRefreshManagedServiceNode ? resolveNodeRunner() : undefined,
  });
}
