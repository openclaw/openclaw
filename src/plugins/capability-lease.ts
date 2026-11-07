export function createPluginRuntimeCapabilityLease(owner: string) {
  let active = true;
  const cleanups = new Set<() => void>();
  const assertActive = (capability: string) => {
    if (!active) {
      throw new Error(`${owner} ${capability} is no longer active`);
    }
  };
  const retain = (cleanup: () => void): (() => void) => {
    if (!active) {
      cleanup();
      assertActive("capability lease");
    }
    const release = () => {
      if (cleanups.delete(release)) {
        cleanup();
      }
    };
    cleanups.add(release);
    return release;
  };
  return {
    isActive: () => active,
    assertActive,
    retain,
    revoke: () => {
      if (!active) {
        return;
      }
      active = false;
      // Attempt every retained cleanup so one throwing cleanup cannot strand the rest;
      // the inactive fence makes a second revoke() a no-op, so failures surface here.
      const failures: unknown[] = [];
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `${owner} capability lease cleanup failed`);
      }
    },
  };
}

export type PluginRuntimeCapabilityLease = ReturnType<typeof createPluginRuntimeCapabilityLease>;
