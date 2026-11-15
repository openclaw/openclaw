import { getPluginInstance } from "./plugin-instance-scope.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime, SubagentForkedTurnParams } from "./runtime/types.js";

/**
 * Runs a plugin's forked turn as its exact registration. The fork outlives the invocation that
 * started it, so authority follows the captured registration, not that call; the fork rechecks it
 * before admission, each tool effect, and settlement. A reload drains this instance only after
 * the fork and its settlement finish.
 */
export async function runPluginForkedTurnAsOwner<T>(
  params: SubagentForkedTurnParams<T>,
  deps: {
    registry: PluginRegistry;
    record: PluginRecord;
    scopedRuntime: boolean;
    runWithPluginScope: <R>(run: () => R) => R;
    subagent: PluginRuntime["subagent"];
  },
) {
  const authority = capturePluginLifecycleAuthority(deps.registry, deps.record, {
    scopedRuntime: deps.scopedRuntime,
  });
  const assertOwnerCurrent = () => {
    if (!authority?.()) {
      throw new Error(`Plugin "${deps.record.id}" runtime is no longer active.`);
    }
  };
  assertOwnerCurrent();
  const releaseWork = getPluginInstance(deps.record)?.retainWork("call");
  try {
    return await deps.runWithPluginScope(() => {
      const scope = getPluginRuntimeGatewayRequestScope();
      return withPluginRuntimeGatewayRequestScope(
        {
          ...scope,
          isWebchatConnect: scope?.isWebchatConnect ?? (() => false),
          assertSystemOwnerCurrent: assertOwnerCurrent,
        },
        () => deps.subagent.runForkedTurn(params),
      );
    });
  } finally {
    releaseWork?.();
  }
}
