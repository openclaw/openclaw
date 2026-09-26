import { expect } from "vitest";

type MockCalls = {
  mock: { calls: unknown[][] };
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isObjectRecord(value), `${label} should be an object`).toBe(true);
  if (!isObjectRecord(value)) {
    throw new Error(`${label} should be an object`);
  }
  return value;
}

export function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), `${label} should be an array`).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error(`${label} should be an array`);
  }
  return value;
}

export function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

export function transcriptMessageContents(events: readonly unknown[]): unknown[] {
  return events
    .map((event) =>
      isObjectRecord(event) && isObjectRecord(event.message) ? event.message.content : undefined,
    )
    .filter((content) => content !== undefined);
}

export function expectRespondPayload(respond: MockCalls): Record<string, unknown> {
  expect(respond.mock.calls).toHaveLength(1);
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  expect(ok).toBe(true);
  expect(error).toBeUndefined();
  return requireRecord(payload, "response payload");
}

export function findSession(
  payload: Record<string, unknown>,
  sessionKey: string,
): Record<string, unknown> {
  const sessions = requireArray(payload.sessions, "response sessions");
  const session = sessions.find(
    (candidate): candidate is Record<string, unknown> =>
      isObjectRecord(candidate) && candidate.key === sessionKey,
  );
  if (!session) {
    throw new Error(`Missing session ${sessionKey}`);
  }
  return session;
}

export function expectChangedBroadcast(
  broadcastToConnIds: MockCalls,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expect(broadcastToConnIds.mock.calls).toHaveLength(1);
  const [event, payload, connIds, options] = broadcastToConnIds.mock.calls[0] ?? [];
  expect(event).toBe("sessions.changed");
  expect(connIds).toEqual(new Set(["conn-1"]));
  expect(options).toEqual({
    agentId: typeof expected.agentId === "string" ? expected.agentId : "main",
    dropIfSlow: true,
    ...(typeof expected.sessionKey === "string" ? { sessionKeys: [expected.sessionKey] } : {}),
  });
  const payloadRecord = requireRecord(payload, "broadcast payload");
  expectFields(payloadRecord, expected);
  return payloadRecord;
}
