export function defer(cleanup: () => void): Disposable {
  return { [Symbol.dispose]: cleanup };
}

export function deferAsync(cleanup: () => Promise<unknown>): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      await cleanup();
    },
  };
}
