export function requireMockCallArg<TArgs extends unknown[]>(
  mockFn: { mock: { calls: TArgs[] } },
  label: string,
  index = 0,
): TArgs[0] {
  const call = mockFn.mock.calls[index];
  if (!call || call.length === 0) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call[0];
}

export function requireMockCall<T extends unknown[] = unknown[]>(
  mockFn: { mock: { calls: T[] } },
  label: string,
  index = 0,
): T {
  const call = mockFn.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call;
}
