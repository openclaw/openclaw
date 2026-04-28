/**
 * Reserved host-owned run-context namespaces exposed via `getHostRunContext`.
 *
 * These namespaces describe state the host knows about a run (subagent
 * progression, parent-run linkage, etc.) and are NOT writable by plugins. The
 * `_host.*` prefix is reserved: any plugin attempting to write a namespace
 * starting with `_host.` is rejected by `setPluginRunContext`.
 *
 * Plugins read host state through `getHostRunContext("_host.runtime")`; the
 * shape returned is a deep snapshot so plugins cannot mutate live host state.
 */

/** Reserved namespace identifier for the host runtime view. */
export const HOST_RUNTIME_NAMESPACE = "_host.runtime" as const;
export type HostRuntimeNamespace = typeof HOST_RUNTIME_NAMESPACE;

/** Prefix that marks a host-owned, plugin-read-only namespace. */
export const HOST_RUNTIME_NAMESPACE_PREFIX = "_host." as const;

/**
 * Snapshot of the host's view of a run's subagent activity, materialised on
 * demand from the agent-events run context. All fields are read-only and
 * structurally cloned so callers cannot mutate live runtime state.
 */
export type HostRuntimeRunContext = {
  /** Run ids of subagents that are still in-flight at snapshot time. */
  readonly openSubagentRunIds: readonly string[];
  /** Wall-clock ms when the most recent subagent settled (success or failure). */
  readonly lastSubagentSettledAt?: number;
  /** Run id of the parent run that spawned this run, if any. */
  readonly parentRunId?: string;
};

export type HostRuntimeNamespaceMap = {
  readonly [HOST_RUNTIME_NAMESPACE]: HostRuntimeRunContext;
};
export type HostRuntimeNamespaceKey = keyof HostRuntimeNamespaceMap;

/** True when the namespace is reserved for the host. */
export function isReservedHostRuntimeNamespace(ns: string): boolean {
  return typeof ns === "string" && ns.startsWith(HOST_RUNTIME_NAMESPACE_PREFIX);
}

/**
 * Narrow a string to a known host runtime namespace. Throws on unknown values
 * so the type system + runtime agree on the supported namespace surface.
 */
export function assertHostRuntimeNamespace(ns: string): asserts ns is HostRuntimeNamespaceKey {
  if (ns !== HOST_RUNTIME_NAMESPACE) {
    throw new Error(`unknown host run-context namespace: ${ns}`);
  }
}
