import { expect, it } from "vitest";
import {
  decodeSessionTranscriptReportFacts,
  projectSessionTranscriptReportFacts,
  type SessionTranscriptReportFacts,
} from "./session-transcript-report-facts.js";

const base = { id: "entry", parentId: "parent", timestamp: "2026-01-01T00:00:00.000Z" };
type ProjectionCase = { raw: unknown; expected: SessionTranscriptReportFacts };
function canonical(
  raw: unknown,
  entry: Extract<SessionTranscriptReportFacts, { kind: "canonical" }>["entry"],
  hasParentId = true,
): ProjectionCase {
  return { raw, expected: { kind: "canonical", hasParentId, entry } };
}
function messageFacts(
  message: unknown,
  facts: { assistantResponseId?: string; assistantRunId?: string } = {},
) {
  return canonical({ ...base, type: "message", message }, { ...base, type: "message", ...facts });
}
const assistant = { role: "assistant", content: [] };

it.each<ProjectionCase>([
  ...(
    [
      { type: "message", message: { role: "user", content: "large body" } },
      { type: "compaction", summary: "summary", firstKeptEntryId: "parent", tokensBefore: 1 },
      { type: "custom", customType: "plugin.metadata", data: { large: "body" } },
    ] as const
  ).map((entry) => canonical({ ...base, ...entry }, { ...base, type: entry.type })),
  canonical(
    {
      ...base,
      type: "custom_message",
      customType: "report",
      content: "body",
      display: true,
      details: { privateToBody: true },
    },
    { ...base, type: "custom_message", customType: "report" },
  ),
  ...["branch label", "", undefined].map((label) =>
    canonical(
      { ...base, type: "label", targetId: "parent", label },
      { ...base, type: "label", targetId: "parent", ...(label !== undefined ? { label } : {}) },
    ),
  ),
  ...(
    [
      ["", " run-1 ", { assistantResponseId: "", assistantRunId: "run-1" }],
      ["  ", "", { assistantResponseId: "  " }],
      ["response", 42, { assistantResponseId: "response" }],
      [42, "  ", {}],
    ] as const
  ).map(([responseId, runId, expected]) =>
    messageFacts({ ...assistant, responseId, __openclaw: { runId } }, expected),
  ),
  messageFacts({
    role: "toolResult",
    content: [],
    toolCallId: "call",
    toolName: "read",
    isError: false,
    responseId: "response",
    __openclaw: { runId: "run" },
  }),
  ...[undefined, "side", { mode: "side" }].flatMap((appendMode): ProjectionCase[] => {
    const entry = {
      id: "hook",
      type: "message" as const,
      ...(appendMode !== undefined ? { appendMode } : {}),
    };
    const message = { role: "custom", content: "hook" };
    return [
      canonical({ ...entry, message }, entry, false),
      canonical({ ...entry, message, parentId: null }, { ...entry, parentId: null }),
    ];
  }),
  ...[
    {
      type: "message",
      message: { role: "assistant", content: [{}], responseId: "must-not-suppress" },
    },
    { type: "future", payload: "body" },
  ].map((raw): ProjectionCase => ({
    raw: { ...base, ...raw },
    expected: { kind: "link", id: base.id, parentId: base.parentId },
  })),
  ...[
    null,
    { ...base, type: "session", version: 3 },
    { ...base, type: "leaf", targetId: null, appendMode: "future" },
    { type: "message", message: { role: "user", content: "Legacy row without an ID" } },
  ].map((raw): ProjectionCase => ({
    raw,
    expected: { kind: "ignored" },
  })),
  ...[
    { targetId: null },
    { targetId: "parent", appendParentId: null },
    { targetId: "parent", appendParentId: "opaque", appendMode: "side" as const },
  ].map((control): ProjectionCase => ({
    raw: { ...base, type: "leaf", ...control },
    expected: { kind: "leaf", entry: { id: base.id, parentId: base.parentId, ...control } },
  })),
  canonical(
    JSON.parse(`{"type":"message","id":"first","id":"last","parentId":null,
      "message":{"role":"assistant","content":42,"responseId":"wrong"},
      "message":{"role":"assistant","content":"valid","responseId":"wrong","responseId":" "}}`),
    { id: "last", parentId: null, type: "message", assistantResponseId: " " },
  ),
  {
    raw: JSON.parse(`{"type":"message","id":"last","parentId":null,
      "message":{"role":"assistant","content":"valid","responseId":"wrong"},
      "message":{"role":"assistant","content":42}}`),
    expected: { kind: "link", id: "last", parentId: null },
  },
])("projects and round-trips report facts: $raw", ({ raw, expected }) => {
  const facts = projectSessionTranscriptReportFacts(raw);
  expect(decodeSessionTranscriptReportFacts(facts)).toStrictEqual(facts);
  const serializedFacts = JSON.stringify(facts);
  const stored: unknown = JSON.parse(serializedFacts);
  const decoded = decodeSessionTranscriptReportFacts(stored);
  expect(decoded).toStrictEqual(stored);
  expect(decoded).toStrictEqual(expected);
});

it.each([
  null,
  { kind: "future" },
  {},
  { kind: "canonical", entry: { ...base, type: "message" } },
  { kind: "canonical", hasParentId: true, entry: { id: "entry", type: "message" } },
  { kind: "canonical", hasParentId: false, entry: { ...base, type: "message" } },
  { kind: "leaf", entry: { ...base } },
  { kind: "link", id: "entry" },
])("rejects malformed persisted facts instead of ignoring the row: %j", (value) => {
  expect(decodeSessionTranscriptReportFacts(value)).toBeUndefined();
});
