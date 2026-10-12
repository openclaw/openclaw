import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseWorkerWorkspaceManifest,
  parseWorkerWorkspaceReconciliationPlan,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";

const file = {
  path: "file",
  type: "file",
  mode: 0o644,
  size: 0,
  sha256: "a".repeat(64),
} satisfies WorkerWorkspaceManifestEntry;
const manifest = { version: 1, baseCommit: null, entries: [file] };
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
  return parseWorkerWorkspaceManifest(
    raw,
    `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  );
}

function readJournal(value: unknown) {
  return parseWorkerWorkspaceReconciliationPlan(JSON.stringify(value));
}

describe("worker workspace manifest parsing", () => {
  it("requires non-array records for manifests, journals, and entries", () => {
    for (const value of [null, [], false, 1, "invalid"]) {
      expect(() => readManifest(value)).toThrow("manifest is invalid");
      expect(() => readJournal(value)).toThrow("journal is invalid");
      expect(() => readManifest({ ...manifest, entries: [value] })).toThrow("invalid entry");
      expect(() => readJournal({ ...journal, baseEntries: [value] })).toThrow("invalid entry");
    }
  });

  it.each([
    {
      field: "mode",
      invalid: [undefined, null, "420", false, [], {}, -1, 0.5, 0o1000],
      error: "invalid mode",
    },
    {
      field: "size",
      invalid: [undefined, null, "0", false, [], {}, -1, 0.5, Number.MAX_SAFE_INTEGER + 1],
      error: "invalid file metadata",
    },
  ])(
    "rejects nonnumeric, fractional, and out-of-range $field values",
    ({ field, invalid, error }) => {
      for (const value of invalid) {
        const entry = { ...file, [field]: value };
        expect(() => readManifest({ ...manifest, entries: [entry] })).toThrow(error);
        expect(() => readJournal({ ...journal, baseEntries: [entry] })).toThrow(error);
      }
    },
  );

  it.each([
    { mode: 0, normalized: 0o644 },
    { mode: 0o777, normalized: 0o755 },
  ])("accepts mode $mode and a zero-byte file", ({ mode, normalized }) => {
    const entry = { ...file, mode };
    const expected = [{ ...file, mode: normalized }];
    expect(readManifest({ ...manifest, entries: [entry] }).entries).toEqual(expected);
    expect(readJournal({ ...journal, baseEntries: [entry] }).baseEntries).toEqual(expected);
  });

  it("preserves null, SHA-1, and SHA-256 base commits", () => {
    for (const baseCommit of [null, "a".repeat(40), "b".repeat(64)]) {
      expect(readManifest({ ...manifest, baseCommit }).baseCommit).toBe(baseCommit);
    }
    for (const baseCommit of [undefined, false, 1, "", "a".repeat(39)]) {
      expect(() => readManifest({ ...manifest, baseCommit })).toThrow("unsupported shape");
    }
  });

  it("rejects duplicate or unsorted manifest paths", () => {
    for (const paths of [
      ["b", "a"],
      ["a", "a"],
    ]) {
      expect(() =>
        readManifest({
          ...manifest,
          entries: paths.map((path) => ({
            path,
            type: file.type,
            mode: file.mode,
            size: file.size,
            sha256: file.sha256,
          })),
        }),
      ).toThrow("not unique and sorted");
    }
  });
});

describe("worker workspace reconciliation journal parsing", () => {
  it("normalizes absent directory arrays without reordering present arrays", () => {
    expect(readJournal(journal)).toMatchObject({ baseDirectories: [], appliedDirectories: [] });
    expect(
      readJournal({ ...journal, baseDirectories: ["z", "a"], appliedDirectories: ["y", "b"] }),
    ).toMatchObject({ baseDirectories: ["z", "a"], appliedDirectories: ["y", "b"] });
  });

  it.each(["baseDirectories", "appliedDirectories"])(
    "rejects invalid %s values and paths",
    (field) => {
      for (const value of [null, false, 0, "", {}]) {
        expect(() => readJournal({ ...journal, [field]: value })).toThrow("unsupported shape");
      }
      for (const value of [[null], ["../outside"], ["dir\\child"], ["/absolute"]]) {
        expect(() => readJournal({ ...journal, [field]: value })).toThrow("unsafe path");
      }
      expect(() => readJournal({ ...journal, [field]: ["same", "same"] })).toThrow(
        "duplicate directories",
      );
    },
  );

  it("retains a validated applied reference and distinguishes absence from null", () => {
    expect(readJournal(journal).appliedManifestRef).toBeUndefined();
    const appliedManifestRef = `sha256:${"f".repeat(64)}`;
    expect(readJournal({ ...journal, appliedManifestRef }).appliedManifestRef).toBe(
      appliedManifestRef,
    );
    for (const value of [null, false, 1, "", `sha256:${"f".repeat(63)}`]) {
      expect(() => readJournal({ ...journal, appliedManifestRef: value })).toThrow(
        "unsupported shape",
      );
    }
  });
});
