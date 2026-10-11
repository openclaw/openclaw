/**
 * Lazy private-local facade for active memory search manager lifecycle operations.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";

type ActiveMemorySearchPurpose = "default" | "status";

/** Active manager lookup result, including a soft error when memory is unavailable. */
export type ActiveMemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

/** Loads the active memory search manager for one agent and purpose. */
export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: ActiveMemorySearchPurpose;
}): Promise<ActiveMemorySearchManagerResult> {
  const runtime = await import("./memory-host-search.runtime.js");
  return await runtime.getActiveMemorySearchManager(params);
}

/** Closes every active memory search manager for the provided config. */
export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  const runtime = await import("./memory-host-search.runtime.js");
  await runtime.closeActiveMemorySearchManagers(cfg);
}

/** Closes the active memory search manager for one agent. */
export async function closeActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const runtime = await import("./memory-host-search.runtime.js");
  await runtime.closeActiveMemorySearchManager(params);
}

export type {
  ActiveMemoryProviderResult,
  MemoryCallerAuthority,
  MemoryCallerContext,
  MemoryReference,
  MemoryCitation,
  MemorySearchHit,
  MemoryHealth,
} from "../plugins/memory-provider-types.js";

/** Opens a caller-bound neutral provider lease; close it when the operation finishes. */
export async function getActiveMemoryProvider(
  params: import("../plugins/memory-provider-types.js").MemoryProviderOpenParams,
): Promise<import("../plugins/memory-provider-types.js").ActiveMemoryProviderResult> {
  const runtime = await import("./memory-host-search.runtime.js");
  return await runtime.getActiveMemoryProvider(params);
}

/** Reports whether the selected slot owner serves the provider-neutral runtime for an agent. */
export async function isActiveMemoryProviderNative(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<boolean> {
  const runtime = await import("./memory-host-search.runtime.js");
  return runtime.isActiveMemoryProviderNative(params);
}
