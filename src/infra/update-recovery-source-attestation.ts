import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import type { PackageActivationReverseImage } from "./package-update-activation-reverse-schema.js";
import {
  assertUpdateRecoverySourceInventory,
  type UpdateRecoverySourceInventory,
} from "./update-recovery-source-image.js";
import {
  MAX_SOURCE_ATTESTATION_BYTES,
  parseUpdateRecoverySourceAttestation,
  updateRecoverySourceRefSchema,
  type UpdateRecoverySourceAttestation,
  type UpdateRecoverySourceRef,
} from "./update-recovery-source-schema.js";

type Entry = UpdateRecoveryBackupManifest["entries"][number];
const suffixes = ["-journal", "-shm", "-wal"];
function fingerprint(stat: fs.BigIntStats) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ];
}

/** Read only an exact immutable ref. This does not confer capture or publication authority. */
export function readUpdateRecoverySourceAttestation(
  ref: UpdateRecoverySourceRef,
  expected: {
    runId: string;
    operationId: string;
    candidateManifestSha256: string;
    entries: readonly Entry[];
  },
): UpdateRecoverySourceAttestation {
  updateRecoverySourceRefSchema.parse(ref);
  const parent = fs.lstatSync(path.dirname(ref.path), { bigint: true });
  const named = fs.lstatSync(ref.path, { bigint: true });
  if (
    !parent.isDirectory() ||
    fs.realpathSync(ref.path) !== ref.path ||
    !named.isFile() ||
    named.nlink !== 1n ||
    (process.platform !== "win32" && (named.mode & 0o777n) !== 0o600n) ||
    (process.getuid && named.uid !== BigInt(process.getuid())) ||
    named.size > BigInt(MAX_SOURCE_ATTESTATION_BYTES)
  ) {
    throw new Error("Update recovery source attestation is not a private immutable file.");
  }
  const fd = fs.openSync(
    ref.path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let raw: Buffer;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!isDeepStrictEqual(fingerprint(named), fingerprint(opened))) {
      throw new Error("Update recovery source attestation changed before reading.");
    }
    // Bound every read even if an uncooperative writer grows the file.
    raw = Buffer.alloc(Number(opened.size));
    let position = 0;
    while (position < raw.length) {
      const size = fs.readSync(fd, raw, position, raw.length - position, position);
      if (!size) {
        throw new Error("Update recovery source attestation was truncated.");
      }
      position += size;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const renamed = fs.lstatSync(ref.path, { bigint: true });
    const finalParent = fs.lstatSync(path.dirname(ref.path), { bigint: true });
    if (
      !isDeepStrictEqual(fingerprint(opened), fingerprint(after)) ||
      !isDeepStrictEqual(fingerprint(after), fingerprint(renamed)) ||
      parent.dev !== finalParent.dev ||
      parent.ino !== finalParent.ino ||
      fs.realpathSync(ref.path) !== ref.path
    ) {
      throw new Error("Update recovery source attestation changed while reading.");
    }
  } finally {
    fs.closeSync(fd);
  }
  if (createHash("sha256").update(raw).digest("hex") !== ref.sha256) {
    throw new Error("Update recovery source attestation digest changed.");
  }
  const value = parseUpdateRecoverySourceAttestation(raw);
  if (
    value.runId !== expected.runId ||
    value.operationId !== expected.operationId ||
    value.candidateManifestSha256 !== expected.candidateManifestSha256
  ) {
    throw new Error(
      "Update recovery source attestation names another run, operation or C manifest.",
    );
  }
  const resources = new Map(value.resources.map((r) => [r.sourcePath, r]));
  if (
    resources.size !== expected.entries.length ||
    new Set(expected.entries.map((e) => e.sourcePath)).size !== expected.entries.length
  ) {
    throw new Error("Update recovery source inventory is not one-to-one with C.");
  }
  for (const entry of expected.entries) {
    const resource = resources.get(entry.sourcePath);
    const image = resource?.image;
    const sqlite = (entry.kind === "file" || entry.kind === "missing") && entry.sqlite;
    if (
      !resource ||
      !image ||
      image.kind !== entry.kind ||
      !isDeepStrictEqual(
        resource.sidecars.map((s) => s.suffix).toSorted(),
        sqlite ? suffixes : [],
      ) ||
      (image.kind === "file" &&
        entry.kind === "file" &&
        (image.mode !== (entry.mode & 0o7777) ||
          (!sqlite && (image.sha256 !== entry.sha256 || image.size !== entry.size)))) ||
      (image.kind === "directory" &&
        entry.kind === "directory" &&
        image.mode !== (entry.mode & 0o7777)) ||
      (image.kind === "symlink" && entry.kind === "symlink" && image.target !== entry.target)
    ) {
      throw new Error(
        "Update recovery source inventory does not match C paths, kinds or metadata.",
      );
    }
  }
  return value;
}

export function matchesUpdateRecoverySourceImage(
  before: PackageActivationReverseImage,
  resource: UpdateRecoverySourceInventory["resources"][number],
  parentIdentity: string,
) {
  const { image } = resource;
  const relativeParent = path.relative(resource.ancestor.path, path.dirname(resource.sourcePath));
  const missingAncestor =
    image.kind === "missing" &&
    before.kind === "missing" &&
    !path.isAbsolute(relativeParent) &&
    relativeParent !== ".." &&
    !relativeParent.startsWith(`..${path.sep}`);
  if (
    (!missingAncestor && resource.ancestor.path !== path.dirname(resource.sourcePath)) ||
    resource.ancestor.identity !== parentIdentity
  ) {
    return false;
  }
  if (image.kind === "missing") {
    return before.kind === "missing";
  }
  const {
    nlink: _nlink,
    mtimeNs: _mtime,
    ctimeNs: _ctime,
    birthtimeNs: _birth,
    ...physical
  } = image;
  if (physical.kind === "directory") {
    const { children: _children, ...directory } = physical;
    return isDeepStrictEqual(before, directory);
  }
  return isDeepStrictEqual(before, physical);
}

/** Admission only: use the ORIGINAL still-held authority, never after a partial reverse. */
export async function assertUpdateRecoverySourceAttestationCurrent(
  attestation: UpdateRecoverySourceAttestation,
  entries: readonly Entry[],
  assertCurrent: () => void,
) {
  await assertUpdateRecoverySourceInventory(
    {
      runId: attestation.runId,
      operationId: attestation.operationId,
      resources: attestation.resources,
    },
    {
      runId: attestation.runId,
      operationId: attestation.operationId,
      assertCurrent,
      resources: entries.map((entry) => ({
        sourcePath: entry.sourcePath,
        kind: entry.kind,
        sqlite: (entry.kind === "file" || entry.kind === "missing") && entry.sqlite,
      })),
    },
  );
}

/** Admission also needs the original producer's pre-snapshot fact, not just fresh live equality. */
export async function assertUpdateRecoverySourceAttestationAdmission(
  attestation: UpdateRecoverySourceAttestation,
  entries: readonly Entry[],
  authority: {
    assertCurrent: () => void;
    sourceAttestation: Readonly<UpdateRecoverySourceRef>;
    assertCapturedSource?: (
      ref: Readonly<UpdateRecoverySourceRef>,
      source: Readonly<UpdateRecoverySourceAttestation>,
    ) => void;
  },
) {
  const assertCurrent = authority.assertCurrent.bind(authority);
  const assertCaptured = authority.assertCapturedSource?.bind(authority);
  const ref = Object.freeze(updateRecoverySourceRefSchema.parse(authority.sourceAttestation));
  assertCurrent();
  if (!assertCaptured) {
    throw new Error("Original pre-snapshot source capture proof is missing.");
  }
  // Retain the authenticated values, not a caller-mutable object or a later stat.
  const source = structuredClone(attestation);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(source);
  const assertOriginalCapture = () => {
    assertCurrent();
    assertCaptured(ref, source);
  };
  assertOriginalCapture();
  await assertUpdateRecoverySourceAttestationCurrent(source, entries, assertCurrent);
  assertOriginalCapture();
  return assertOriginalCapture;
}
