import { expect, test } from "vitest";
import {
  MAX_TRANSCRIPT_PARSE_LINE_BYTES,
  parseTranscriptRecord,
} from "./session-transcript-record-parser.js";

test.each([
  { parentId: null, timestamp: "2026-10-16T12:00:00Z" },
  { parentId: 'parent"\\id', timestamp: 1.7e21 },
])("retains oversized record metadata with $timestamp", ({ parentId, timestamp }) => {
  const id = 'message"\\id';
  const idempotencyKey = 'delivery"\\key';
  const parsed = parseTranscriptRecord(
    JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp,
      message: {
        role: "user",
        idempotencyKey,
        content: "x".repeat(MAX_TRANSCRIPT_PARSE_LINE_BYTES),
      },
    }),
  );

  expect(parsed?.id).toBe(id);
  expect(parsed?.record).toMatchObject({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", idempotencyKey, __openclaw: { truncated: true, reason: "oversized" } },
  });
});
