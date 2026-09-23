import { expect } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { deliverQueuedSessionDelivery } from "./server-restart-sentinel.js";

type GeneratedMediaDeliveryEntry = Extract<
  Parameters<typeof deliverQueuedSessionDelivery>[0]["entry"],
  { kind: "agentTurn" }
>;

export function createGeneratedMediaDeliveryEntry(
  overrides: Partial<GeneratedMediaDeliveryEntry> &
    Pick<GeneratedMediaDeliveryEntry, "id" | "messageId">,
): GeneratedMediaDeliveryEntry {
  return {
    kind: "agentTurn",
    sessionKey: "agent:main:main",
    message: "generated image ready",
    enqueuedAt: 1,
    retryCount: 0,
    route: { channel: "discord", to: "channel:123", chatType: "channel" },
    inputProvenance: {
      kind: "inter_session",
      sourceChannel: "internal",
      sourceTool: "image_generate",
    },
    sourceReplyDeliveryMode: "automatic",
    ...overrides,
  };
}

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
