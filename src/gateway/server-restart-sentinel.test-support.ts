export function mockCallArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0];
}

export function lastMockCallArg(mock: { mock: { calls: Array<Array<unknown>> } }): unknown {
  const calls = mock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("Expected last mock call");
  }
  return call[0];
}
