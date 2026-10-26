import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  parseWorkerWorkspaceManifest,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceManifest as serializeManifest,
} from "./workspace-manifest.js";

const sha256 = "a".repeat(64);
const file = { path: "file", type: "file" as const, mode: 0o644, size: 0, sha256 };
const manifestRef = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const manifest = { version: 1 as const, baseCommit: null, entries: [file] };
const journal = {
  version: 1,
  temporaryNonce: "a".repeat(32),
  baseManifestRef: `sha256:${"b".repeat(64)}`,
  currentManifestRef: `sha256:${"c".repeat(64)}`,
  baseEntries: [file],
  appliedEntries: [],
  baseTree: "d".repeat(40),
  basePackSha256: "e".repeat(64),
};

function readManifest(value: unknown) {
  const raw = JSON.stringify(value);
  return parseWorkerWorkspaceManifest(raw, manifestRef(raw));
}

function readJournal(value: unknown) {
  return parseWorkerWorkspaceReconciliationPlan(JSON.stringify(value));
}

const directory = (path: string) => ({ path, type: "directory", mode: 0o700 });
const namedFile = (path: string) => ({ ...file, path });
function rejects(values: readonly unknown[], read: (value: unknown) => unknown, error: string) {
  for (const value of values) {
    expect(() => read(value)).toThrow(error);
  }
}
function rejectsEntry(value: unknown, error: string) {
  expect(() => readManifest({ ...manifest, entries: [value] })).toThrow(error);
  expect(() => readJournal({ ...journal, baseEntries: [value] })).toThrow(error);
}

it.each([false, true])("projects caches using trusted input context: %s", (trusted) => {
  const authored = ".artifacts/build-all-cache/authored.txt";
  const generated = ".artifacts/build-cache-inputs/compile.json";
  const directories = [".artifacts", ".artifacts/build-all-cache", ".artifacts/build-cache-inputs"];
  const entries = [authored, generated].map(namedFile);
  const rawEntries = [...directories.map(directory), ...entries].toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  // Receipt contents cannot supply their own input-custody facts.
  const raw = JSON.stringify({ ...manifest, entries: rawEntries, buildCacheInputs: [generated] });
  const ref = manifestRef(raw);
  const buildCacheInputs = trusted ? [authored] : undefined;
  const expected = {
    ...manifest,
    entries: (trusted ? [authored] : [authored, generated]).map(namedFile),
    directories: trusted ? directories.slice(0, 2) : directories,
  };
  expect(parseWorkerWorkspaceManifest(raw, ref, buildCacheInputs)).toEqual({
    ...expected,
    ...(trusted ? { buildCacheInputs } : {}),
  });
  const serialized = serializeManifest({ ...manifest, entries, directories, buildCacheInputs });
  expect(readManifest(JSON.parse(serialized))).toEqual(expected);
  expect(JSON.parse(serialized).buildCacheInputs).toBeUndefined();
});

it("requires non-array records for manifests, journals, and entries", () => {
  for (const value of [null, [], false, 1, "invalid"]) {
    expect(() => readManifest(value)).toThrow("manifest is invalid");
    expect(() => readJournal(value)).toThrow("journal is invalid");
    rejectsEntry(value, "invalid entry");
  }
});

const invalidNumbers = [undefined, null, false, [], {}, -1, 0.5];
const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
it.each([
  ["mode", [...invalidNumbers, "420", 0o1000], "invalid mode"],
  ["size", [...invalidNumbers, "0", unsafeInteger], "invalid file metadata"],
] as const)("rejects invalid %s metadata", (field, invalid, error) => {
  for (const value of invalid) {
    rejectsEntry({ ...file, [field]: value }, error);
  }
});

it.each([
  [0, 0o644],
  [0o777, 0o755],
])("normalizes mode %i on a zero-byte file", (mode, normalized) => {
  const entry = { ...file, mode };
  const expected = [{ ...file, mode: normalized }];
  expect(readManifest({ ...manifest, entries: [entry] }).entries).toEqual(expected);
  expect(readJournal({ ...journal, baseEntries: [entry] }).baseEntries).toEqual(expected);
});

it("preserves null, SHA-1, and SHA-256 base commits", () => {
  for (const baseCommit of [null, "a".repeat(40), "b".repeat(64)]) {
    expect(readManifest({ ...manifest, baseCommit }).baseCommit).toBe(baseCommit);
  }
  rejects(
    [undefined, false, 1, "", "a".repeat(39)],
    (baseCommit) => readManifest({ ...manifest, baseCommit }),
    "unsupported shape",
  );
});

it("rejects duplicate or unsorted manifest paths", () => {
  for (const paths of [
    ["b", "a"],
    ["a", "a"],
  ]) {
    expect(() => readManifest({ ...manifest, entries: paths.map(namedFile) })).toThrow(
      "not unique and sorted",
    );
  }
});
it.each(["baseDirectories", "appliedDirectories", "appliedManifestRef"] as const)(
  "validates optional journal field %s without reordering directories",
  (field) => {
    const read = (value: unknown) => readJournal({ ...journal, [field]: value });
    const isReference = field === "appliedManifestRef";
    const valid = isReference ? `sha256:${"f".repeat(64)}` : ["z", "a"];
    expect(readJournal(journal)[field]).toEqual(isReference ? undefined : []);
    expect(read(valid)[field]).toEqual(valid);
    if (isReference) {
      rejects([null, false, 1, "", `sha256:${"f".repeat(63)}`], read, "unsupported shape");
    } else {
      rejects([null, false, 0, "", {}], read, "unsupported shape");
      rejects([[null], ["../outside"], ["dir\\child"], ["/absolute"]], read, "unsafe path");
      rejects([["same", "same"]], read, "duplicate directories");
    }
  },
);
