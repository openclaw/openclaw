const rootsKey = Symbol.for("openclaw.testSolidRoots");

function roots(): Set<() => void> {
  const state = globalThis as typeof globalThis & { [rootsKey]?: Set<() => void> };
  return (state[rootsKey] ??= new Set());
}

export function trackSolidRoot(dispose: () => void): () => void {
  const activeRoots = roots();
  const unmount = () => {
    if (!activeRoots.delete(unmount)) {
      return;
    }
    dispose();
  };
  activeRoots.add(unmount);
  return unmount;
}

// The registry outlives vi.resetModules(); the worker must retire roots before
// clearing either the document or the module graph that created their effects.
export function cleanupSolid(): void {
  const errors: unknown[] = [];
  for (const unmount of roots()) {
    try {
      unmount();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Solid test root cleanup failed");
  }
}
