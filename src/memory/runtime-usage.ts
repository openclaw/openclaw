const MEMORY_RUNTIME_USAGE_KEY = Symbol.for("openclaw.memoryRuntimeUsage");

type MemoryRuntimeUsageState = {
  used: boolean;
};

function getMemoryRuntimeUsageState(): MemoryRuntimeUsageState {
  const globalState = globalThis as typeof globalThis & {
    [MEMORY_RUNTIME_USAGE_KEY]?: MemoryRuntimeUsageState;
  };
  const existing = globalState[MEMORY_RUNTIME_USAGE_KEY];
  if (existing) {
    return existing;
  }
  const created: MemoryRuntimeUsageState = { used: false };
  globalState[MEMORY_RUNTIME_USAGE_KEY] = created;
  return created;
}

/** Mark that the CLI touched memory-search manager state during this process. */
export function markMemoryRuntimeUsed(): void {
  getMemoryRuntimeUsageState().used = true;
}

/** Return whether this process needs memory-manager teardown on exit. */
export function wasMemoryRuntimeUsed(): boolean {
  return getMemoryRuntimeUsageState().used;
}

/** Reset the process-local memory runtime usage marker. */
export function resetMemoryRuntimeUsage(): void {
  getMemoryRuntimeUsageState().used = false;
}
