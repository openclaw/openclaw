import { hash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  ["aaaaa", "aaaaaa", true],
  ["aaaaaa", "aaaaaaa", true],
  ["aaaaaaa", "aaaaaaaa", true],
  ["aaaaaa", "aaaaab", true],
  ["aaaaaaa", "aaaaaab", true],
  ["a", "a\0", true],
  ["\u007f", "\u0080", true],
  ["🦞\ud800", "🦞\ufffd", true],
])("compares primitive JSON values %j → %j", (before, after, changed) => {
  expect(compare({ value: before }, { value: after })).toEqual({
    set: changed ? { value: after } : {},
    remove: [],
  });
});

it("packs nine ASCII JSON characters without native hashing or retained text", () => {
  vi.mocked(hash).mockClear();
  const { fingerprints } = prepareSessionRowDeltaFields({
    agentId: "main",
    sharingRole: "owner",
    permissionMode: "allow",
    reasoningLevel: "off",
    empty: [],
    viewer: "viewer",
    status: "running",
    longer: "spectator",
  });
  expect(hash).toHaveBeenCalledExactlyOnceWith("sha256", '"spectator"', "buffer");
  expect([...fingerprints.values()].every((value) => typeof value === "bigint")).toBe(true);
});

it.each(["", "allow", "allows", "viewer", "running", "\u007f", "\u0080", "\0", "\ud800"])(
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

it("matches JSON patches through consecutive revisions and audience changes", () => {
  const values = [
    undefined,
    null,
    Number.NaN,
    -0,
    0,
    false,
    "",
    "allow",
    "viewer",
    "🦞\ud800",
    "long preview ".repeat(100),
    { b: [undefined, -0], a: 1 },
    { a: 1, b: [null, 0] },
  ];
  let previous: Record<string, unknown> = {};
  let fields = prepareSessionRowDeltaFields(previous);
  for (let revision = 0; revision < values.length * 3; revision++) {
    const row = Object.freeze({
      label: "Stable title across revisions",
      value: values[revision % values.length],
      ...(revision % 2 ? { audience: "viewer" } : {}),
      nested: { z: revision % 3, a: { ignored: undefined, nil: Number.NaN } },
    });
    const previousJson = JSON.stringify(previous);
    const currentJson = JSON.stringify(row);
    const before: Record<string, unknown> = JSON.parse(previousJson);
    const after: Record<string, unknown> = JSON.parse(currentJson);
    const expected = {
      set: Object.fromEntries(
        Object.keys(after)
          .filter((field) => !isDeepStrictEqual(before[field], after[field]))
          .map((field) => [field, Reflect.get(row, field)]),
      ),
      remove: Object.keys(before).filter((field) => !(field in after)),
    };
    const current = prepareSessionRowDeltaFields(row);
    expect(createSessionRowDeltaDiffer()(fields, current, row)).toEqual(expected);
    previous = row;
    fields = current;
  }
});

it("reuses materialized field digests across clock samples without hiding viewer or source changes", () => {
  const source = Object.freeze({
    label: "Original label",
    status: "running",
    unread: false,
    model: "original-model",
    subagentCount: 2,
  });
  const initial = prepareSessionRowDeltaFields(source, source);
  vi.mocked(hash).mockClear();
  for (let snapshotAt = 0; snapshotAt < 20; snapshotAt++) {
    const current = { ...source, snapshotAt };
    expect(
      createSessionRowDeltaDiffer()(
        initial,
        prepareSessionRowDeltaFields(current, source),
        current,
      ),
    ).toEqual({ set: { snapshotAt }, remove: [] });
  }
  expect(hash).not.toHaveBeenCalled();
  const overrides = {
    label: "Viewer label",
    status: "done",
    unread: true,
    model: "next-model",
    subagentCount: 3,
  };
  for (const [field, value] of Object.entries(overrides)) {
    const current = { ...source, [field]: value };
    expect(
      createSessionRowDeltaDiffer()(
        initial,
        prepareSessionRowDeltaFields(current, source),
        current,
      ),
    ).toEqual({ set: { [field]: value }, remove: [] });
  }
  const replacement = Object.freeze(overrides);
  const current = { ...replacement };
  expect(
    createSessionRowDeltaDiffer()(
      initial,
      prepareSessionRowDeltaFields(current, replacement),
      current,
    ),
  ).toEqual({ set: overrides, remove: [] });
});
