import { expect, it } from "vitest";
import {
  decodeSessionTranscriptReportFacts,
  projectSessionTranscriptReportFacts,
  type SessionTranscriptReportFacts,
} from "./session-transcript-report-facts.js";

const base = { id: "entry", parentId: "parent", timestamp: "2026-01-01T00:00:00.000Z" };
type ProjectionCase = { name: string; raw: unknown; expected: SessionTranscriptReportFacts };

it.each<ProjectionCase>([
  ...(
    [
      { type: "message", message: { role: "user", content: "large body" } },
      { type: "compaction", summary: "summary", firstKeptEntryId: "parent", tokensBefore: 1 },
      { type: "custom", customType: "plugin.metadata", data: { large: "body" } },
      {
        type: "custom_message",
        customType: "report",
        content: "large report body",
        display: true,
        details: { privateToBody: true },
      },
    ] as const
  ).map((entry): ProjectionCase => ({
    name: `${entry.type} navigation excludes the body`,
    raw: { ...base, ...entry },
    expected: {
      kind: "canonical",
      hasParentId: true,
      entry:
        entry.type === "custom_message"
          ? { ...base, type: entry.type, customType: "report" }
          : { ...base, type: entry.type },
    },
  })),
  ...["branch label", "", undefined].map((label): ProjectionCase => ({
    name: `label ${String(label)}`,
    raw: { ...base, type: "label", targetId: "parent", label },
    expected: {
      kind: "canonical",
      hasParentId: true,
      entry: {
        ...base,
        type: "label",
        targetId: "parent",
        ...(label !== undefined ? { label } : {}),
      },
    },
  })),
  ...[
    {
      responseId: "",
      runId: " run-1 ",
      expected: { assistantResponseId: "", assistantRunId: "run-1" },
    },
    { responseId: "  ", runId: "", expected: { assistantResponseId: "  " } },
    { responseId: "response", runId: 42, expected: { assistantResponseId: "response" } },
    { responseId: 42, runId: "  ", expected: {} },
  ].map(({ responseId, runId, expected }): ProjectionCase => ({
    name: `assistant suppression identities ${JSON.stringify(responseId)} / ${JSON.stringify(runId)}`,
    raw: {
      ...base,
      type: "message",
      message: { role: "assistant", content: [], responseId, __openclaw: { runId } },
    },
    expected: {
      kind: "canonical",
      hasParentId: true,
      entry: { ...base, type: "message", ...expected },
    },
  })),
  {
    name: "tool results have no assistant suppression identity",
    raw: {
      ...base,
      type: "message",
      message: {
        role: "toolResult",
        content: [],
        toolCallId: "call",
        toolName: "read",
        isError: false,
        responseId: "response",
        __openclaw: { runId: "run" },
      },
    },
    expected: { kind: "canonical", hasParentId: true, entry: { ...base, type: "message" } },
  },
  ...[undefined, "side", { mode: "side" }].flatMap((appendMode): ProjectionCase[] => {
    const entry = {
      id: "hook",
      type: "message" as const,
      ...(appendMode !== undefined ? { appendMode } : {}),
    };
    const message = { role: "custom", content: "hook" };
    return [
      {
        name: `parentless append mode ${JSON.stringify(appendMode)}`,
        raw: { ...entry, message },
        expected: { kind: "canonical", hasParentId: false, entry },
      },
      {
        name: `null parent append mode ${JSON.stringify(appendMode)}`,
        raw: { ...entry, message, parentId: null },
        expected: { kind: "canonical", hasParentId: true, entry: { ...entry, parentId: null } },
      },
    ];
  }),
  ...[
    {
      type: "message",
      message: { role: "assistant", content: [{}], responseId: "must-not-suppress" },
    },
    { type: "future", payload: "body" },
  ].map((raw): ProjectionCase => ({
    name: `opaque ${raw.type} keeps its link`,
    raw: { ...base, ...raw },
    expected: { kind: "link", id: base.id, parentId: base.parentId },
  })),
  ...[
    null,
    { ...base, type: "session", version: 3 },
    { ...base, type: "leaf", targetId: null, appendMode: "future" },
    { type: "message", message: { role: "user", content: "Legacy row without an ID" } },
  ].map((raw): ProjectionCase => ({
    name: `ignored ${JSON.stringify(raw)}`,
    raw,
    expected: { kind: "ignored" },
  })),
  ...[
    { targetId: null },
    { targetId: "parent", appendParentId: null },
    { targetId: "parent", appendParentId: "opaque", appendMode: "side" as const },
  ].map((control): ProjectionCase => ({
    name: `leaf ${JSON.stringify(control)}`,
    raw: { ...base, type: "leaf", ...control },
    expected: { kind: "leaf", entry: { id: base.id, parentId: base.parentId, ...control } },
  })),
  {
    name: "JavaScript selects the last duplicate member",
    raw: JSON.parse(`{"type":"message","id":"first","id":"last","parentId":null,
      "message":{"role":"assistant","content":42,"responseId":"wrong"},
      "message":{"role":"assistant","content":"valid","responseId":"wrong","responseId":" "}}`),
    expected: {
      kind: "canonical",
      hasParentId: true,
      entry: { id: "last", parentId: null, type: "message", assistantResponseId: " " },
    },
  },
  {
    name: "a malformed last duplicate message stays opaque",
    raw: JSON.parse(`{"type":"message","id":"last","parentId":null,
      "message":{"role":"assistant","content":"valid","responseId":"wrong"},
      "message":{"role":"assistant","content":42}}`),
    expected: { kind: "link", id: "last", parentId: null },
  },
  {
    name: "projected absent fields survive serialization",
    raw: { id: "parentless", type: "message", message: { role: "user", content: "body" } },
    expected: {
      kind: "canonical",
      hasParentId: false,
      entry: { id: "parentless", type: "message" },
    },
  },
])("projects report facts: $name", ({ raw, expected }) => {
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
