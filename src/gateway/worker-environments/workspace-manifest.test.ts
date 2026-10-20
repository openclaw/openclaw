import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseWorkerWorkspaceManifest,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceManifest,
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
  it("prunes cache-only ancestors while preserving original empty directories", () => {
    const directories = [
      ".artifacts",
      ".artifacts/vitest-worker-cache",
      ".local",
      ".local/share",
      ".local/share/pnpm",
      ".local/share/pnpm/store",
      "empty",
      "nested",
      "nested/empty",
    ];
    const entries = [
      { ...file, path: ".artifacts/vitest-worker-cache/out.js" },
      { ...file, path: ".local/share/pnpm/store/content" },
      file,
    ];
    const original = {
      ...manifest,
      entries: [
        ...directories.map((path) => ({ path, type: "directory", mode: 0o700 })),
        ...entries,
      ].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    };
    const expected = { ...manifest, directories: ["empty", "nested", "nested/empty"] };
    expect(readManifest(original)).toEqual(expected);
    expect(
      readManifest(
        JSON.parse(
          serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries, directories }),
        ),
      ),
    ).toEqual(expected);
  });

  it("applies the local build-cache policy only with trusted input context", () => {
    const authored = ".artifacts/build-all-cache/authored.txt";
    const generated = ".artifacts/build-cache-inputs/compile.json";
    const value = {
      ...manifest,
      entries: [
        { path: ".artifacts", type: "directory", mode: 0o700 },
        { path: ".artifacts/build-all-cache", type: "directory", mode: 0o700 },
        { ...file, path: authored },
        { path: ".artifacts/build-cache-inputs", type: "directory", mode: 0o700 },
        { ...file, path: generated },
        file,
      ],
      // Receipt contents cannot supply their own input-custody facts.
      buildCacheInputs: [generated],
    };
    const raw = JSON.stringify(value);
    const ref = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const ordinary = parseWorkerWorkspaceManifest(raw, ref);
    expect(ordinary.entries.map((entry) => entry.path)).toEqual([authored, generated, "file"]);
    expect(ordinary.buildCacheInputs).toBeUndefined();
    const local = parseWorkerWorkspaceManifest(raw, ref, [authored]);
    expect(local.entries.map((entry) => entry.path)).toEqual([authored, "file"]);
    expect(JSON.parse(serializeWorkerWorkspaceManifest(local)).buildCacheInputs).toBeUndefined();
    expect(() => parseWorkerWorkspaceManifest(raw + " ", ref, [authored])).toThrow("digest");
  });

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
