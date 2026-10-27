import { hash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createSessionRowDeltaDiffer,
  prepareSessionRowDeltaFields,
} from "./session-row-delta-fields.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, hash: vi.fn(crypto.hash) };
});

const compare = (previous: Record<string, unknown>, current: Record<string, unknown>) =>
  createSessionRowDeltaDiffer()(
    prepareSessionRowDeltaFields(previous),
    prepareSessionRowDeltaFields(current),
    current,
  );

it("preserves JSON values and removes fields that disappear from the wire", () => {
  const previous = Object.fromEntries(
    ["removed", "nowUndefined", "nil", "enabled", "runtimeMs", "runs"].map((key) => [key, "old"]),
  );
  const current = {
    nowUndefined: undefined,
    nil: null,
    enabled: false,
    runtimeMs: 0,
    runs: [],
    added: "new",
  };
  expect(compare(previous, current)).toEqual({
    set: { nil: null, enabled: false, runtimeMs: 0, runs: [], added: "new" },
    remove: ["removed", "nowUndefined"],
  });
});

it.each([
  [-0, 0, false],
  [Number.NaN, null, false],
  [Infinity, null, false],
  [-Infinity, null, false],
  [null, Number.NaN, false],
  [1, "1", true],
  [true, "true", true],
  ["", "", false],
  ["allow", "allow", false],
  ["allow", "allows", true],
  ["a", "a\0", true],
  ["\u007f", "\u0080", true],
  ["🦞\ud800", "🦞\ufffd", true],
])("compares primitive JSON values %j → %j", (before, after, changed) => {
  expect(compare({ value: before }, { value: after })).toEqual({
    set: changed ? { value: after } : {},
    remove: [],
  });
});

it("avoids native hashing for short ASCII JSON while retaining only numeric fingerprints", () => {
  vi.mocked(hash).mockClear();
  const { fingerprints } = prepareSessionRowDeltaFields({
    agentId: "main",
    sharingRole: "owner",
    permissionMode: "allow",
    reasoningLevel: "off",
    empty: [],
    longer: "viewer",
  });
  expect(hash).toHaveBeenCalledExactlyOnceWith("sha256", '"viewer"', "buffer");
  expect([...fingerprints.values()].every((value) => typeof value === "bigint")).toBe(true);
});

it.each(["", "allow", "allows", "\u007f", "\u0080", "\0", "\ud800"])(
  "keeps a short JSON string equivalent to an object encoding the same value: %j",
  (value) => {
    expect(compare({ value }, { value: { toJSON: () => value } })).toEqual({
      set: {},
      remove: [],
    });
  },
);

it("compares nested JSON semantically and replaces a changed nested field whole", () => {
  const previous = {
    activity: { b: [null, { done: false }], a: 1 },
    usage: { input: 4, output: 3 },
  };
  const current = {
    activity: { a: 1, b: [undefined, { done: false, ignored: undefined }] },
    usage: { input: 4, output: 5 },
  };
  expect(compare(previous, current)).toEqual({
    set: { usage: { input: 4, output: 5 } },
    remove: [],
  });
});

it("recomputes mutable children shared by distinct shallow-frozen row snapshots", () => {
  const usage = { input: 4, output: 3 };
  const previous = prepareSessionRowDeltaFields(Object.freeze({ usage }));
  usage.output = 5;
  const current = Object.freeze({ usage });
  expect(
    createSessionRowDeltaDiffer()(previous, prepareSessionRowDeltaFields(current), current),
  ).toEqual({ set: { usage: { input: 4, output: 5 } }, remove: [] });
});
