import { expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import {
  selectActivePath,
  transcriptRepairUserKey,
  type TranscriptEntry,
} from "./legacy-transcript-repair.js";

// No entry carries a `leafId`, so the reader falls back to walking parents from the last entry.
const message = (
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
): TranscriptEntry => ({ id, parentId, type: "message", message: { role, content } });

const withRuntimeContext = (text: string) =>
  `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\ninternal detail\n${INTERNAL_RUNTIME_CONTEXT_END}\n${text}`;

it("walks parents back from the last entry when no leaf is recorded", () => {
  const entries = [
    message("a", null, "user", "first"),
    message("b", "a", "assistant", "second"),
    message("c", "b", "user", "third"),
  ];
  expect(selectActivePath(entries)?.entries).toEqual(entries);
});

it("ignores session header rows when resolving the active path", () => {
  const entries = [
    { id: "session", type: "session" } as TranscriptEntry,
    message("a", "session", "user", "first"),
  ];
  expect(selectActivePath(entries)?.entries.map((entry) => entry.id)).toEqual(["a"]);
});

it("returns no path without any entries to walk", () => {
  expect(selectActivePath([])).toBeNull();
  expect(selectActivePath([{ id: "session", type: "session" } as TranscriptEntry])).toBeNull();
});

it("keys only user messages that carry an id", () => {
  expect(transcriptRepairUserKey(message("a", null, "assistant", "hi"), false)).toBeUndefined();
  expect(transcriptRepairUserKey(message("", null, "user", "hi"), false)).toBeUndefined();
  expect(transcriptRepairUserKey(message("a", null, "user", "hi"), false)).toBe("\u0000hi");
});

it("reads text from both plain and part-based content", () => {
  expect(transcriptRepairUserKey(message("a", null, "user", "hi"), false)).toBe("\u0000hi");
  expect(
    transcriptRepairUserKey(message("a", null, "user", [{ type: "text", text: "hi" }]), false),
  ).toBe("\u0000hi");
  expect(
    transcriptRepairUserKey(message("a", null, "user", [{ type: "text" }]), false),
  ).toBeUndefined();
});

it("drops user text that carries no runtime context when stripping", () => {
  const entry = message("a", "root", "user", "plain question");
  expect(transcriptRepairUserKey(entry, false)).toBe("root\u0000plain question");
  expect(transcriptRepairUserKey(entry, true)).toBeUndefined();
});

it("strips runtime context before keying so a rewritten copy still matches", () => {
  const entry = message("a", "root", "user", withRuntimeContext("real question"));
  const raw = transcriptRepairUserKey(entry, false);
  const stripped = transcriptRepairUserKey(entry, true);
  expect(stripped).toBeDefined();
  expect(stripped).not.toBe(raw);
  expect(stripped).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
  expect(stripped).toContain("real question");
});
