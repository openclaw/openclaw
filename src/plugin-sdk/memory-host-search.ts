/**
 * Lazy public SDK facade for active memory search manager lifecycle operations.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RegisteredMemorySearchManager } from "../plugins/memory-state.js";

type ActiveMemorySearchPurpose = "default" | "status";

/** Active manager lookup result, including a soft error when memory is unavailable. */
export type ActiveMemorySearchManagerResult = {
  manager: RegisteredMemorySearchManager | null;
  error?: string;
};

type MemoryHostSearchRuntimeModule = typeof import("./memory-host-search.runtime.js");

async function loadMemoryHostSearchRuntime(): Promise<MemoryHostSearchRuntimeModule> {
  return await import("./memory-host-search.runtime.js");
}

/** Loads the active memory search manager for one agent and purpose. */
export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: ActiveMemorySearchPurpose;
}): Promise<ActiveMemorySearchManagerResult> {
  const runtime = await loadMemoryHostSearchRuntime();
  return await runtime.getActiveMemorySearchManager(params);
}

/** Closes every active memory search manager for the provided config. */
export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  const runtime = await loadMemoryHostSearchRuntime();
  await runtime.closeActiveMemorySearchManagers(cfg);
}

/**
 * Closes the active memory search manager for one agent.
 *
 * `scope` defaults to "manager" (retire the agent's shared manager). Pass
 * "resources" to release only the disposable per-agent recall resources and keep
 * the shared manager alive — active-memory recall-timeout cleanup uses this so a
 * request-scoped timeout does not retire the QMD manager that chat memory_search
 * shares (#96455).
 */
export async function closeActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  scope?: "manager" | "resources";
}): Promise<void> {
  const runtime = await loadMemoryHostSearchRuntime();
  await runtime.closeActiveMemorySearchManager(params);
}
