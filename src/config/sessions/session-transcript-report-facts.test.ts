import { describe, expect, it } from "vitest";
import {
  decodeSessionTranscriptReportFacts,
  projectSessionTranscriptReportFacts,
  type SessionTranscriptReportFacts,
} from "./session-transcript-report-facts.js";

const base = { id: "entry", parentId: "parent", timestamp: "2026-01-01T00:00:00.000Z" };

function roundTrip(raw: unknown) {
  const facts = projectSessionTranscriptReportFacts(raw);
  const serializedFacts = JSON.stringify(facts);
  const stored: unknown = JSON.parse(serializedFacts);
  const decoded = decodeSessionTranscriptReportFacts(stored);
  expect(decoded).toStrictEqual(stored);
  return decoded;
}

describe("session transcript report facts", () => {
  it.each([
    { type: "message", message: { role: "user", content: "large body" } },
    { type: "thinking_level_change", thinkingLevel: "high" },
    { type: "model_change", provider: "openai", modelId: "synthetic" },
    { type: "compaction", summary: "summary", firstKeptEntryId: "parent", tokensBefore: 1 },
    { type: "reset", reason: ["reset"] },
    { type: "branch_summary", fromId: "parent", summary: "branch" },
    { type: "custom", customType: "plugin.metadata", data: { large: "body" } },
    { type: "session_info", name: "session" },
  ])("retains $type navigation without its body", (entry) => {
    expect(roundTrip({ ...base, ...entry })).toStrictEqual({
      kind: "canonical",
      hasParentId: true,
      entry: { ...base, type: entry.type },
    });
  });

  it("retains custom report selection and label changes without report content", () => {
    expect(
      roundTrip({
        ...base,
        type: "custom_message",
        customType: "report",
        content: "large report body",
        display: true,
        details: { privateToBody: true },
      }),
    ).toStrictEqual({
      kind: "canonical",
      hasParentId: true,
      entry: { ...base, type: "custom_message", customType: "report" },
    });
    for (const label of ["branch label", "", undefined]) {
      expect(roundTrip({ ...base, type: "label", targetId: "parent", label })).toStrictEqual({
        kind: "canonical",
        hasParentId: true,
        entry: {
          ...base,
          type: "label",
          targetId: "parent",
          ...(label !== undefined ? { label } : {}),
        },
      });
    }
  });

  it.each([
    {
      responseId: "",
      runId: " run-1 ",
      expected: { assistantResponseId: "", assistantRunId: "run-1" },
    },
    { responseId: "  ", runId: "", expected: { assistantResponseId: "  " } },
    { responseId: "response", runId: 42, expected: { assistantResponseId: "response" } },
    { responseId: 42, runId: "  ", expected: {} },
  ])(
    "preserves assistant suppression identities $responseId / $runId",
    ({ responseId, runId, expected }) => {
      expect(
        roundTrip({
          ...base,
          type: "message",
          message: { role: "assistant", content: [], responseId, __openclaw: { runId } },
        }),
      ).toStrictEqual({
        kind: "canonical",
        hasParentId: true,
        entry: { ...base, type: "message", ...expected },
      });
    },
  );

  it("does not assign assistant suppression identities to tool results", () => {
    expect(
      roundTrip({
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
      }),
    ).toStrictEqual({
      kind: "canonical",
      hasParentId: true,
      entry: { ...base, type: "message" },
    });
  });

  it.each([undefined, "side", "future-mode", null, 42, { mode: "side" }])(
    "preserves parentless entries and append mode %j",
    (appendMode) => {
      const entry = {
        id: "hook",
        type: "message",
        appendMode,
        message: { role: "custom", content: "hook" },
      };
      const expectedEntry = {
        id: "hook",
        type: "message",
        ...(appendMode !== undefined ? { appendMode } : {}),
      };
      expect(roundTrip(entry)).toStrictEqual({
        kind: "canonical",
        hasParentId: false,
        entry: expectedEntry,
      });
      expect(roundTrip({ ...entry, parentId: null })).toStrictEqual({
        kind: "canonical",
        hasParentId: true,
        entry: { ...expectedEntry, parentId: null },
      });
    },
  );

  it.each([
    {
      name: "malformed assistant",
      raw: {
        type: "message",
        message: { role: "assistant", content: [{}], responseId: "must-not-suppress" },
      },
      kind: "link",
    },
    {
      name: "unreadable custom report",
      raw: { type: "custom_message", customType: "report", content: 42, display: true },
      kind: "link",
    },
    {
      name: "incomplete model change",
      raw: { type: "model_change", provider: "openai" },
      kind: "link",
    },
    { name: "unknown entry", raw: { type: "future", payload: "body" }, kind: "link" },
    { name: "untyped link", raw: {}, kind: "link" },
    { name: "non-string type", raw: { type: 42 }, kind: "link" },
    { name: "session", raw: { type: "session", version: 3 }, kind: "ignored" },
    { name: "invalid leaf target", raw: { type: "leaf", targetId: 42 }, kind: "ignored" },
    { name: "missing leaf target", raw: { type: "leaf" }, kind: "ignored" },
    {
      name: "invalid leaf mode",
      raw: { type: "leaf", targetId: null, appendMode: "future" },
      kind: "ignored",
    },
  ])("preserves opaque semantics for $name", ({ raw, kind }) => {
    expect(roundTrip({ ...base, ...raw })).toStrictEqual(
      kind === "link"
        ? { kind: "link", id: base.id, parentId: base.parentId }
        : { kind: "ignored" },
    );
  });

  it.each([
    null,
    [],
    42,
    { type: "session", id: 42 },
    { type: "future", id: "no-parent" },
    { type: "message", message: { role: "user", content: "Legacy row without an ID" } },
  ])("ignores values without a usable navigation link: %j", (raw) => {
    expect(roundTrip(raw)).toStrictEqual({ kind: "ignored" });
  });

  it.each([
    { targetId: null },
    { targetId: "unknown-until-navigation" },
    { targetId: "parent", appendParentId: null },
    { targetId: "parent", appendParentId: "opaque", appendMode: "side" },
  ])("retains leaf controls for the navigation owner: %j", (control) => {
    expect(roundTrip({ ...base, type: "leaf", ...control })).toStrictEqual({
      kind: "leaf",
      entry: { id: base.id, parentId: base.parentId, ...control },
    });
  });

  it("uses JavaScript's last duplicate member from the original JSON", () => {
    const raw: unknown = JSON.parse(`{"type":"message","id":"first","id":"last","parentId":null,
      "message":{"role":"assistant","content":42,"responseId":"wrong"},
      "message":{"role":"assistant","content":"valid","responseId":"wrong","responseId":" "}}`);
    expect(roundTrip(raw)).toStrictEqual({
      kind: "canonical",
      hasParentId: true,
      entry: { id: "last", parentId: null, type: "message", assistantResponseId: " " },
    });
    const malformedLast: unknown = JSON.parse(`{"type":"message","id":"last","parentId":null,
      "message":{"role":"assistant","content":"valid","responseId":"wrong"},
      "message":{"role":"assistant","content":42}}`);
    expect(roundTrip(malformedLast)).toStrictEqual({ kind: "link", id: "last", parentId: null });
  });
});

describe("stored session transcript report facts", () => {
  it("accepts projected absent fields before and after JSON serialization", () => {
    const raw = { id: "parentless", type: "message", message: { role: "user", content: "body" } };
    const facts = projectSessionTranscriptReportFacts(raw);
    expect(decodeSessionTranscriptReportFacts(facts)).toStrictEqual(facts);
    expect(roundTrip(raw)).toStrictEqual({
      kind: "canonical",
      hasParentId: false,
      entry: { id: "parentless", type: "message" },
    });
  });

  it.each([
    null,
    [],
    { kind: "future" },
    { kind: "canonical", entry: { ...base, type: "message" } },
    { kind: "canonical", hasParentId: true, entry: { id: "entry", type: "message" } },
    { kind: "canonical", hasParentId: false, entry: { ...base, type: "message" } },
    { kind: "canonical", hasParentId: true, entry: { ...base, type: "session" } },
    { kind: "canonical", hasParentId: false, entry: { ...base, type: "message", id: "" } },
    { kind: "canonical", hasParentId: true, entry: { ...base, type: "message", timestamp: 42 } },
    { kind: "canonical", hasParentId: true, entry: { ...base, type: "message", parentId: 42 } },
    {
      kind: "canonical",
      hasParentId: true,
      entry: { ...base, type: "message", assistantResponseId: 42 },
    },
    {
      kind: "canonical",
      hasParentId: true,
      entry: { ...base, type: "message", assistantRunId: null },
    },
    { kind: "canonical", hasParentId: true, entry: { ...base, type: "custom_message" } },
    { kind: "canonical", hasParentId: true, entry: { ...base, type: "label", targetId: "" } },
    { kind: "leaf", entry: { ...base } },
    { kind: "leaf", entry: { ...base, targetId: null, appendMode: "future" } },
    { kind: "link", id: "entry" },
    { kind: "link", id: "entry", parentId: 42 },
  ])("rejects malformed persisted facts instead of ignoring the row: %j", (value) => {
    expect(decodeSessionTranscriptReportFacts(value)).toBeUndefined();
  });

  it("distinguishes a valid ignored row from malformed facts", () => {
    const ignored: SessionTranscriptReportFacts = { kind: "ignored" };
    expect(decodeSessionTranscriptReportFacts(ignored)).toStrictEqual(ignored);
    expect(decodeSessionTranscriptReportFacts({})).toBeUndefined();
  });
});
