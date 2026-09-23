import { expect, vi } from "vitest";

export type TranscriptLine = {
  message?: Record<string, unknown>;
};

export function collectMessagesWithIdempotencyKey(
  lines: TranscriptLine[],
  idempotencyKey: string,
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.message?.idempotencyKey === idempotencyKey) {
      messages.push(line.message);
    }
  }
  return messages;
}

export function findMessageWithIdempotencyKey(
  lines: TranscriptLine[],
  idempotencyKey: string,
): Record<string, unknown> | undefined {
  for (const line of lines) {
    if (line.message?.idempotencyKey === idempotencyKey) {
      return line.message;
    }
  }
  return undefined;
}

export function collectAssistantRowsWithText(
  lines: TranscriptLine[],
  text: string,
): Record<string, unknown>[] {
  return lines
    .map((line) => line.message)
    .filter(
      (message): message is Record<string, unknown> =>
        message?.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text" &&
            (block as { text?: unknown }).text === text,
        ),
    );
}

export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

export function expectAbortPayload(payload: unknown, expected?: { runIds?: string[] }) {
  const actual = expectRecord(payload, "abort payload");
  expect(actual.aborted).toBe(true);
  if (expected?.runIds) {
    expect(actual.runIds).toEqual(expected.runIds);
  }
  return actual;
}

export function expectAbortPayloadContainsRunIds(payload: unknown, runIds: string[]) {
  const actual = expectAbortPayload(payload);
  expect(Array.isArray(actual.runIds)).toBe(true);
  for (const runId of runIds) {
    expect(actual.runIds as unknown[]).toContain(runId);
  }
}

export function requireLastRespondCall(respond: ReturnType<typeof vi.fn>): unknown[] {
  const calls = respond.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

export function expectPersistedAbortMessage(
  message: unknown,
  expected: {
    idempotencyKey: string;
    origin: string;
    runId: string;
    stopReason?: string;
  },
) {
  const actual = expectRecord(message, "persisted abort message");
  expect(actual.idempotencyKey).toBe(expected.idempotencyKey);
  if (expected.stopReason) {
    expect(actual.stopReason).toBe(expected.stopReason);
  }
  const abort = expectRecord(actual.openclawAbort, "persisted abort metadata");
  expect(abort.aborted).toBe(true);
  expect(abort.origin).toBe(expected.origin);
  expect(abort.runId).toBe(expected.runId);
}
