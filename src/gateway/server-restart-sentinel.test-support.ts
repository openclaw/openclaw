import { expect } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export function expectCapturedQueueContext(stateDir: string) {
  return expect.objectContaining({
    environment: expect.objectContaining({ OPENCLAW_STATE_DIR: stateDir }),
    admission: expect.objectContaining({
      databasePath: resolveOpenClawStateSqlitePath({
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      }),
    }),
  });
}

export function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

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

export function expectMockCallFields(
  mock: { mock: { calls: Array<Array<unknown>> } },
  expected: Record<string, unknown>,
  callIndex = 0,
): Record<string, unknown> {
  return expectRecordFields(mockCallArg(mock, callIndex), expected);
}
