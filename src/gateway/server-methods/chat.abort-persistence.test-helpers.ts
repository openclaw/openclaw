import { expect, vi } from "vitest";

export type TranscriptLine = {
  message?: Record<string, unknown>;
};

export function collectMessagesWithIdempotencyKey(
  lines: TranscriptLine[],
  idempotencyKey: string,
): Record<string, unknown>[] {
  return lines.flatMap(({ message }) =>
    message?.idempotencyKey === idempotencyKey ? [message] : [],
  );
}

export function findMessageWithIdempotencyKey(
  lines: TranscriptLine[],
  idempotencyKey: string,
): Record<string, unknown> | undefined {
  return lines.find(({ message }) => message?.idempotencyKey === idempotencyKey)?.message;
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
  expect(actual.runIds).toEqual(expect.arrayContaining(runIds));
}

export function requireLastRespondCall(respond: ReturnType<typeof vi.fn>): unknown[] {
  const call = respond.mock.calls.at(-1);
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
  expect(actual).toMatchObject({
    idempotencyKey: expected.idempotencyKey,
    ...(expected.stopReason ? { stopReason: expected.stopReason } : {}),
    openclawAbort: { aborted: true, origin: expected.origin, runId: expected.runId },
  });
}
