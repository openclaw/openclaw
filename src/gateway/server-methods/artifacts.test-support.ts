import { expect } from "vitest";
import { selectSessionArtifacts } from "../session-artifact-read.js";
import { expectRecordFields } from "../test-helpers.assertions.js";

type ResponderCalls = Array<{ ok: boolean; payload?: unknown; error?: unknown }>;
type ArtifactListPayload = { artifacts?: Array<Record<string, unknown>> };

export function withArtifactFixtureReader(
  actual: typeof import("../session-transcript-readers.js"),
  visitSessionMessagesAsync: typeof actual.visitSessionMessagesAsync,
) {
  return {
    ...actual,
    visitSessionMessagesAsync,
    readSessionArtifacts: (
      scope: Parameters<typeof selectSessionArtifacts>[0],
      query: Parameters<typeof selectSessionArtifacts>[1],
    ) =>
      selectSessionArtifacts(scope, query, {
        visitSessionMessagesAsync,
        readSessionMessagesPageWithStatsAsync: actual.readSessionMessagesPageWithStatsAsync,
      }),
  };
}

export function runtimeContext(config: Record<string, unknown>) {
  return { getRuntimeConfig: () => config };
}

export function expectOkPayload(calls: ResponderCalls): unknown {
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload;
}

export function expectArtifactList(calls: ResponderCalls): ArtifactListPayload {
  return expectOkPayload(calls) as ArtifactListPayload;
}

export function expectFirstArtifact(calls: ResponderCalls): Record<string, unknown> | undefined {
  const payload = expectArtifactList(calls);
  return payload.artifacts?.[0];
}

export function expectErrorDetails(calls: ResponderCalls): Record<string, unknown> | undefined {
  expect(calls[0]?.ok).toBe(false);
  return calls[0] ? (calls[0].error as { details?: Record<string, unknown> }).details : undefined;
}

export function assistantImageMessage(params: {
  data?: string;
  alt: string;
  seq?: number;
  runId?: string;
  taskId?: string;
}) {
  return {
    role: "assistant",
    content: [{ type: "image", data: params.data ?? "aGVsbG8=", alt: params.alt }],
    __openclaw: {
      seq: params.seq ?? 2,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.taskId ? { messageTaskId: params.taskId } : {}),
    },
  };
}

export function assistantFileMessage(params: {
  data?: string;
  title: string;
  seq?: number;
  runId?: string;
  taskId?: string;
}) {
  return {
    role: "assistant",
    content: [
      {
        type: "file",
        data: params.data ?? "aGVsbG8=",
        mimeType: "text/plain",
        title: params.title,
      },
    ],
    __openclaw: {
      seq: params.seq ?? 2,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
    },
  };
}

export function resultImageMessage() {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "see attached" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png", alt: "result.png" },
    ],
    __openclaw: { seq: 2 },
  };
}

export function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

export function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expectRecordFields(value, "fields", expected);
}
