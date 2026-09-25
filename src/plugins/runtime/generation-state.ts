// Keep retained registry reads independent of metadata discovery and plugin loading.
import {
  getPluginExecutionFrame,
  runWithPluginExecutionFrame,
} from "../plugin-instance-invocation.js";
import type { PluginRegistry } from "../registry-types.js";
import { getPluginRuntimeExecutionFrame, PluginRuntimeExecutionFrame } from "./execution-frame.js";

export function withPluginRuntimeGenerationRegistryScope<T>(
  registry: PluginRegistry,
  run: () => T,
): T {
  const current = getPluginExecutionFrame();
  return runWithPluginExecutionFrame(
    new PluginRuntimeExecutionFrame(
      current ?? {},
      getPluginRuntimeExecutionFrame(current)?.gatewayScope,
      registry,
    ),
    run,
  );
}

/** Exact registry owned by the prepared generation, including empty selections. */
export function getPluginRuntimeGenerationRegistry(): PluginRegistry | undefined {
  return getPluginRuntimeExecutionFrame()?.generationRegistry;
}

export function runOutsidePluginRuntimeGenerationRegistryScope<T>(run: () => T): T {
  const current = getPluginExecutionFrame();
  return runWithPluginExecutionFrame(
    new PluginRuntimeExecutionFrame(
      current ?? {},
      getPluginRuntimeExecutionFrame(current)?.gatewayScope,
      undefined,
    ),
    run,
  );
}
