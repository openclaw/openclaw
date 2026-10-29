import { readSessionMessageIdentity as identity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import { projectTranscriptEntryMessage as projectEntry } from "./session-transcript-entry-message.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

const position = { source: "selected-snapshot", rawSeq: 4 };
type Position = typeof position | undefined;
type ProjectionOptions = Parameters<typeof projectSessionMessagePayload>[0];
const mainKey = "agent:main:main";
const message = {
  role: "assistant",
  content: "done",
  __openclaw: { transcriptPosition: { source: "untrusted", rawSeq: 0 } },
};
const project = (raw: unknown, options: Partial<Omit<ProjectionOptions, "message">> = {}) =>
  projectSessionMessagePayload({ message: raw, sessionKey: mainKey, ...options });
const metadata = (raw: unknown) => asOptionalRecord(asOptionalRecord(raw)?.["__openclaw"]);
function projections(raw: unknown, entry: unknown, at: Position, key = mainKey) {
  return [
    projectChatDisplayMessage(projectEntry(entry, 2, at)),
    project(raw, { messageId: "entry", messageSeq: 2, transcriptPosition: at, sessionKey: key })
      .payload?.message,
  ];
}

it.each([false, true])("keeps plugin steering audience-specific (delta=%s)", (historyDelta) => {
  const raw = {
    role: "user",
    display: false,
    content: "Model instructions: be concise",
    provenance: { kind: "internal_system", sourceTool: "plugin:reviewer" },
    __openclaw: {
      pluginSteering: { pluginId: "reviewer", pluginName: "Reviewer", displayText: "Be concise" },
    },
  };
  const original = structuredClone(raw);
  expect(project(raw, { historyDelta }).payload).toBeUndefined();
  expect(project(raw, { historyDelta, includePluginSteering: true }).payload).toHaveProperty(
    "message.content",
    [{ type: "text", text: "Be concise" }],
  );
  expect(project(raw, { historyDelta }).payload).toBeUndefined();
  expect(raw).toEqual(original);
});

it.each([
  [[], true],
  [[{ type: "text", text: "Useful partial answer" }], false],
  [[{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], false],
] as const)("defers diagnostics: %j", (content, pending) => {
  const raw = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "context exceeded",
    content,
    __openclaw: { runId: "recovering-run" },
  };
  const original = structuredClone(raw);
  const result = project(raw);
  expect(result.deferredAssistantError === true).toBe(pending);
  expect(Boolean(result.payload)).toBe(!pending);
  expect(result.projectionState).toMatchObject({ assistantErrorPending: true });
  if (result.payload) {
    for (const key of ["openclawRunError", "stopReason", "errorMessage"]) {
      expect(result.payload.message).not.toHaveProperty(key);
    }
  }
  expect(raw).toEqual(original);
});

it("keeps nested activity ownership distinct from entry deduplication in history and live events", () => {
  const activity = {
    ...createNestedToolActivity({
      runId: "run",
      scopeId: "attempt",
      afterEntryId: "parent",
      startOrder: 0,
      parentToolCallId: "exec",
      toolCallId: "nested-read",
      toolName: "read",
      input: { path: "example.txt" },
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
      startedAt: 1,
      timestamp: 2,
    }),
    idempotencyKey: "key",
  };
  const expected = { id: "entry", sequence: 2, runId: "run", idempotencyKey: "key", sendId: null };
  for (const projected of projections(
    activity,
    { type: "message", id: "entry", message: activity },
    position,
    "agent:main:dashboard:nested",
  )) {
    expect(identity(projected)).toMatchObject(expected);
    expect(metadata(projected)?.transcriptPosition).toEqual(position);
  }
  expect(activity).not.toHaveProperty("__openclaw");
});

it.each([
  [undefined, false],
  [position, false],
  [undefined, true],
  [position, true],
] as const)("uses only reader-supplied placement (%j, custom=%s)", (transcriptPosition, custom) => {
  const customMessage = {
    role: "custom",
    customType: "run-failed-before-reply",
    content: "This turn ended before a reply.",
    display: true,
    details: { runId: "failed-run", error: "PRIVATE_DIAGNOSTIC" },
  };
  const timestamp = "2026-09-08T00:00:00.000Z";
  const raw = custom ? { ...customMessage, timestamp: Date.parse(timestamp) } : message;
  const entry = custom
    ? { ...customMessage, type: "custom_message", id: "entry", timestamp }
    : { type: "message", id: "entry", message };
  for (const projected of projections(raw, entry, transcriptPosition)) {
    expect(metadata(projected)?.transcriptPosition).toEqual(transcriptPosition);
    expect(metadata(projected)).toMatchObject({ id: "entry", seq: 2 });
    if (custom) {
      expect(identity(projected)?.runId).toBe("failed-run");
      expect(projected).not.toHaveProperty("details");
    }
  }
  expect(message["__openclaw"].transcriptPosition.source).toBe("untrusted");
});

it.each(["compaction", "reset"])("keeps %s markers in the physical coordinate space", (type) => {
  const run = { runId: "run-compaction", itemId: "item-compaction" };
  const projected = projectEntry(
    { type, id: "boundary", tokensBefore: 100, tokensAfter: 25, __openclaw: run },
    3,
    position,
  );
  expect(metadata(projected)).toEqual({
    kind: type,
    id: "boundary",
    seq: 3,
    transcriptPosition: position,
    ...(type === "compaction" ? { ...run, tokensBefore: 100, tokensAfter: 25 } : {}),
  });
});
