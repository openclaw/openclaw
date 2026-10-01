import {
  InvocationFrame,
  pluginInstanceInvocation,
  runWithPluginExecutionFrame,
} from "../plugin-instance-invocation.js";
import { getPluginInstanceOwner, pluginInvocationContext } from "../plugin-instance-scope.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "./gateway-request-scope.js";

/** Bind new background work to its exact instance without retaining a caller's admission. */
export function capturePluginBackgroundContext(): <T>(run: () => T) => T {
  const instance = pluginInstanceInvocation.getStore()?.instance;
  const owner = instance && getPluginInstanceOwner(instance);
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const frame = new InvocationFrame({});
  return <T>(run: () => T): T =>
    runWithPluginExecutionFrame(frame, () =>
      pluginInvocationContext.exit(() =>
        withPluginRuntimeGatewayContextResolver(
          resolveGatewayContext,
          () => {
            // Publication can adopt the same instance. Pin each new call to that
            // registry so later adoption cannot move work already in flight.
            if (owner?.instance) {
              // Cleanup may close a watcher that is itself awaiting this callback.
              return owner.instance.runInRegistry(owner.registry, run, { joinDisposal: false });
            }
            return instance ? instance.run(run) : run();
          },
          { inheritRequestScope: false },
        ),
      ),
    );
}
