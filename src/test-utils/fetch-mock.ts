export const withFetchPreconnect = <T extends (...args: unknown[]) => unknown>(
  fn: T,
): typeof fetch =>
  Object.assign(fn, {
    preconnect: () => {},
  }) as unknown as typeof fetch;
