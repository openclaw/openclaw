export async function withSpies<T>(
  spies: readonly { mockRestore(): void }[],
  run: () => Promise<T>,
  deferredSpies: readonly { mockRestore(): void }[] = [],
): Promise<T> {
  try {
    return await run();
  } finally {
    for (const spy of [...spies, ...deferredSpies]) {
      spy.mockRestore();
    }
  }
}
