/**
 * Supplies a Gateway request context to scheduler-owned agent runs.
 *
 * Timer ticks, hook dispatch queues, and heartbeat wakeups have no Gateway
 * request of their own, so trusted built-in tools (terminal, dashboard) resolve
 * no context and fail mid-run. RPC-triggered runs already inherit a scope from
 * their caller and must keep it.
 */
import { withoutGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { captureSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

type ScheduledGatewayContextResolver = () => GatewayRequestContext | undefined;

/**
 * Fences a raw context reference behind the owning Gateway instance lifecycle.
 *
 * The process-wide holder is not cleared on shutdown, so a queued run could
 * otherwise resolve a retired context. The context's own `resolveGatewayContext`
 * returns undefined once its instance is unavailable; prefer no context over a
 * retired one, because a missing context fails visibly.
 */
export function fenceScheduledGatewayContextResolver(
  resolveGatewayContext: ScheduledGatewayContextResolver,
): ScheduledGatewayContextResolver;
export function fenceScheduledGatewayContextResolver(resolveGatewayContext: undefined): undefined;
export function fenceScheduledGatewayContextResolver(
  resolveGatewayContext: ScheduledGatewayContextResolver | undefined,
): ScheduledGatewayContextResolver | undefined;
export function fenceScheduledGatewayContextResolver(
  resolveGatewayContext: ScheduledGatewayContextResolver | undefined,
): ScheduledGatewayContextResolver | undefined {
  if (!resolveGatewayContext) {
    return undefined;
  }
  const resolveScheduledContext = () => {
    const context = resolveGatewayContext();
    return context?.resolveGatewayContext?.() ?? undefined;
  };
  // Keep the execution fence while retaining the host identity used by shutdown.
  bindGatewayContextResolver(resolveScheduledContext, resolveGatewayContext);
  return resolveScheduledContext;
}

/** Capture host resources; detached runs replace inherited request and tool-caller scopes. */
export function createScheduledGatewayRunner(
  resolveGatewayContext?: ScheduledGatewayContextResolver,
) {
  const spawnBroker = getSpawnBroker();
  const runWithReadOnlyWorkers = captureSqliteReadOnlyWorkerScope();
  return async <T>(run: () => Promise<T>): Promise<T> =>
    await withoutGatewayToolCallerIdentity(() =>
      runWithSpawnBroker(spawnBroker, async () => {
        const runWithWorkers = () => runWithReadOnlyWorkers(run);
        if (!resolveGatewayContext) {
          return await runWithWorkers();
        }
        return await withPluginRuntimeGatewayContextResolver(
          resolveGatewayContext,
          runWithWorkers,
          {
            inheritRequestScope: false,
          },
        );
      }),
    );
}
