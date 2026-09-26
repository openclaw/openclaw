import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as durability from "./directory-durability.js";
import {
  assertReverseParents,
  syncPackageReverseInputs,
} from "./package-update-activation-reverse-files.js";
import {
  readUpdateRecoverySourceAttestation,
  matchesUpdateRecoverySourceImage,
  assertUpdateRecoverySourceAttestationCurrent,
} from "./update-recovery-source-attestation.js";
import { parseUpdateRecoverySourceAttestation } from "./update-recovery-source-schema.js";
import { sourceInventoryFixture } from "./update-recovery-source.test-support.js";

it("admits complete physical inventory and refuses unknown, duplicate, omitted or unbounded transport", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "source-schema-")));
  try {
    const live = path.join(root, "live");
    fs.mkdirSync(live, { mode: 0o700 });
    const file = path.join(live, "file");
    const missing = path.join(live, "missing");
    const link = path.join(live, "link");
    fs.writeFileSync(file, "physical source", { mode: 0o600 });
    fs.symlinkSync("file", link);
    let held = true;
    const assertCurrent = () => {
      if (!held) {
        throw new Error("Authority released");
      }
    };
    const inventory = sourceInventoryFixture({
      runId: "run",
      operationId: "op",
      resources: [
        { sourcePath: live },
        { sourcePath: file, sqlite: true },
        { sourcePath: missing },
        { sourcePath: link },
      ],
    });
    const attestation = {
      protocol: "update-recovery-source-v1" as const,
      runId: inventory.runId,
      operationId: inventory.operationId,
      candidateManifestSha256: "a".repeat(64),
      resources: inventory.resources,
    };
    const serialized = JSON.stringify(attestation) + "\n";
    expect(parseUpdateRecoverySourceAttestation(Buffer.from(serialized))).toEqual(attestation);
    const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
    const ref = { path: path.join(root, "source.json"), sha256: sha256(serialized) };
    fs.writeFileSync(ref.path, serialized, { flag: "wx", mode: 0o600 });
    const expected = {
      runId: "run",
      operationId: "op",
      candidateManifestSha256: attestation.candidateManifestSha256,
      entries: [
        { kind: "directory" as const, sourcePath: live, mode: fs.statSync(live).mode & 0o7777 },
        {
          kind: "file" as const,
          sourcePath: file,
          mode: fs.statSync(file).mode & 0o7777,
          sqlite: true,
          sha256: "b".repeat(64),
          size: 12,
          archivePath: "payload/0",
        },
        { kind: "missing" as const, sourcePath: missing, sqlite: false, directory: false },
        { kind: "symlink" as const, sourcePath: link, target: "file" },
      ],
    };
    expect(readUpdateRecoverySourceAttestation(ref, expected)).toEqual(attestation);
    await assertUpdateRecoverySourceAttestationCurrent(
      attestation,
      expected.entries,
      assertCurrent,
    );
    const malformed: unknown[] = [
      { ...attestation, unknown: true },
      { ...attestation, runId: "x".repeat(129) },
      { ...attestation, candidateManifestSha256: "not-a-digest" },
      { ...attestation, resources: [...attestation.resources, attestation.resources[0]] },
      {
        ...attestation,
        resources: attestation.resources.map((r) => ({
          ...r,
          ancestor: { ...r.ancestor, extra: true },
        })),
      },
      {
        ...attestation,
        resources: attestation.resources.map((r) => ({ ...r, image: { ...r.image, extra: true } })),
      },
      {
        ...attestation,
        resources: attestation.resources.map((r) =>
          r.sourcePath === file ? { ...r, sidecars: [r.sidecars[0], r.sidecars[0]] } : r,
        ),
      },
      {
        ...attestation,
        resources: attestation.resources.map((r) =>
          r.sourcePath === file
            ? { ...r, image: { ...r.image, size: Number.MAX_SAFE_INTEGER + 1 } }
            : r,
        ),
      },
      {
        ...attestation,
        resources: attestation.resources.map((r) => ({ ...r, sourcePath: r.sourcePath + "/" })),
      },
      {
        ...attestation,
        resources: attestation.resources.map((r) =>
          r.sourcePath === live ? { ...r, image: { ...r.image, children: ["file", "file"] } } : r,
        ),
      },
    ];
    for (const input of malformed) {
      expect(() =>
        parseUpdateRecoverySourceAttestation(Buffer.from(JSON.stringify(input) + "\n")),
      ).toThrow();
    }
    expect(() =>
      parseUpdateRecoverySourceAttestation(
        Buffer.from(serialized.replace('"runId":"run"', '"runId":"forged","runId":"run"')),
      ),
    ).toThrow("canonical encoding");
    for (const field of ["runId", "operationId", "candidateManifestSha256"] as const) {
      expect(() =>
        readUpdateRecoverySourceAttestation(ref, { ...expected, [field]: "wrong" }),
      ).toThrow("another run");
    }
    expect(() =>
      readUpdateRecoverySourceAttestation(ref, { ...expected, entries: expected.entries.slice(1) }),
    ).toThrow("one-to-one");
    expect(() =>
      readUpdateRecoverySourceAttestation(ref, {
        ...expected,
        entries: [...expected.entries, expected.entries[0]!],
      }),
    ).toThrow("one-to-one");
    expect(() =>
      readUpdateRecoverySourceAttestation(ref, {
        ...expected,
        entries: expected.entries.map((e) => (e.sourcePath === file ? { ...e, sqlite: false } : e)),
      }),
    ).toThrow("paths, kinds or metadata");
    const omitted = {
      ...attestation,
      resources: attestation.resources.map((r) => ({ ...r, sidecars: [] })),
    };
    const omittedRaw = JSON.stringify(omitted) + "\n";
    fs.writeFileSync(ref.path, omittedRaw);
    expect(() =>
      readUpdateRecoverySourceAttestation({ ...ref, sha256: sha256(omittedRaw) }, expected),
    ).toThrow("paths, kinds or metadata");
    fs.writeFileSync(ref.path, serialized);
    if (process.platform !== "win32") {
      fs.chmodSync(ref.path, 0o644);
      expect(() => readUpdateRecoverySourceAttestation(ref, expected)).toThrow("private immutable");
    }
    // libuv reports writable Windows files as 0666, even when created with 0600.
    // Exercise that policy with real file bytes; this is not native Windows proof.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      fs.chmodSync(ref.path, 0o666);
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(readUpdateRecoverySourceAttestation(ref, expected)).toEqual(attestation);
    } finally {
      Object.defineProperty(process, "platform", platform);
      fs.chmodSync(ref.path, 0o600);
    }
    fs.linkSync(ref.path, path.join(root, "hardlink"));
    expect(() => readUpdateRecoverySourceAttestation(ref, expected)).toThrow("private immutable");
    fs.unlinkSync(path.join(root, "hardlink"));
    fs.symlinkSync(ref.path, path.join(root, "alias"));
    expect(() =>
      readUpdateRecoverySourceAttestation({ ...ref, path: path.join(root, "alias") }, expected),
    ).toThrow("private immutable");
    // Equal bytes on a foreign inode are a changed source, not valid C.
    const same = fs.readFileSync(file);
    fs.renameSync(file, path.join(root, "old-file"));
    fs.writeFileSync(file, same, { mode: 0o600 });
    await expect(
      assertUpdateRecoverySourceAttestationCurrent(attestation, expected.entries, assertCurrent),
    ).rejects.toThrow("changed after capture");
    held = false;
    await expect(
      assertUpdateRecoverySourceAttestationCurrent(attestation, expected.entries, assertCurrent),
    ).rejects.toThrow("Authority released");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["binding", "durability", "awaited-parent-change"] as const)(
  "preserves nested absence and rejects changed ancestry at %s",
  async (edge) => {
    const root = tempDirs.make("source-absence-");
    const sourcePath = path.join(root, "never-created", "nested", "agent.sqlite");
    const assertCurrent = () => {};
    const inventory = sourceInventoryFixture({
      runId: "run",
      operationId: "op",
      resources: [{ sourcePath, sqlite: true }],
    });
    const captured = inventory.resources[0]!;
    expect(captured.ancestor.path).toBe(root);
    const resource = {
      role: "state" as const,
      live: sourcePath,
      parentIdentity: captured.ancestor.identity,
      before: { kind: "missing" as const },
      after: { kind: "missing" as const },
      move: null,
    };
    if (edge === "binding") {
      expect(
        matchesUpdateRecoverySourceImage(resource.before, captured, resource.parentIdentity),
      ).toBe(true);
      expect(
        matchesUpdateRecoverySourceImage(
          resource.before,
          {
            ...captured,
            ancestor: { ...captured.ancestor, path: path.join(root, "unrelated") },
          },
          resource.parentIdentity,
        ),
      ).toBe(false);
      expect(matchesUpdateRecoverySourceImage(resource.before, captured, "1:2")).toBe(false);
    } else if (edge === "durability") {
      await syncPackageReverseInputs([resource], assertCurrent, [], []);
    } else {
      // A real directory sync yields before the nearest parent changes.
      const syncDirectory = durability.syncDirectory;
      vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
        const result = await syncDirectory(directory);
        if (directory === root) {
          fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        }
        return result;
      });
      await expect(syncPackageReverseInputs([resource], assertCurrent, [], [])).rejects.toThrow(
        "parent changed",
      );
      expect(fs.existsSync(sourcePath)).toBe(false);
      return;
    }
    expect(fs.readdirSync(root)).toEqual([]);
    expect(() => assertReverseParents(resource)).not.toThrow();
    expect(() => assertReverseParents({ ...resource, parentIdentity: "1:2" })).toThrow(
      "parent changed",
    );
    // Even when the resource remains absent, a closer ancestor invalidates capture.
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    expect(() => assertReverseParents(resource)).toThrow("parent changed");
    await expect(syncPackageReverseInputs([resource], assertCurrent, [], [])).rejects.toThrow(
      "parent changed",
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
  },
);
