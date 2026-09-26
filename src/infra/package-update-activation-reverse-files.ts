import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { hashFileDescriptorSync, sameFileMutationFingerprint } from "./file-descriptor.js";
import {
  encodePackageActivationLauncher,
  type PackageActivationDescriptor,
} from "./package-update-activation-journal.js";
import type {
  PackageActivationReverseImage,
  PackageActivationReverseResource,
} from "./package-update-activation-reverse-schema.js";
import { readPackageReverseSymlink } from "./package-update-activation-symlink.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";

export function assertLauncherImage(image: PackageActivationReverseImage, expected: string | null) {
  if (image.kind !== "missing" && image.kind !== "file" && image.kind !== "symlink") {
    throw new Error("Original launcher image is not a file, symlink or absence.");
  }
  // Compare the SAME captured digest/metadata with the journal. A fresh pathname
  // fingerprint could observe different bytes during a transient substitution.
  const actual =
    image.kind === "missing"
      ? null
      : encodePackageActivationLauncher({
          type: image.kind,
          mode: String(
            image.mode | (image.kind === "symlink" ? fs.constants.S_IFLNK : fs.constants.S_IFREG),
          ),
          uid: image.uid,
          gid: image.gid,
          contents: image.kind === "symlink" ? image.target : image.sha256,
        });
  if (actual !== expected) {
    throw new Error("Captured launcher image does not match the original journal.");
  }
}

export function readReverseFile(file: string, maxBytes: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
      throw new Error("Reverse file is unsafe or exceeds its bound.");
    }
    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(data.length) !== before.size
    ) {
      throw new Error("Reverse file changed while reading.");
    }
    return data;
  } finally {
    fs.closeSync(fd);
  }
}
export function reverseFileDigest(file: string): string {
  return createHash("sha256")
    .update(readReverseFile(file, 1024 * 1024 * 1024))
    .digest("hex");
}
export async function readPackageReverseImage(
  file: string,
  packageLogical?: string,
  externalExecutable = false,
): Promise<PackageActivationReverseImage> {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
  if (!stat) {
    return { kind: "missing" };
  }
  if (
    stat.ino === 0n ||
    (!externalExecutable && process.getuid && stat.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Reverse resource owner or inode is unsafe.");
  }
  const metadata = {
    identity: `${stat.dev}:${stat.ino}`,
    mode: Number(stat.mode & 0o7777n),
    uid: String(stat.uid),
    gid: String(stat.gid),
  };
  if (packageLogical) {
    const value = await createPackageIntegrityReader().tree(file, packageLogical);
    return { kind: "package", ...metadata, ...value };
  }
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", ...metadata, target: readPackageReverseSymlink(file, stat) };
  }
  if (stat.isDirectory()) {
    return { kind: "directory", ...metadata };
  }
  if (!stat.isFile() || stat.nlink !== 1n) {
    throw new Error("Reverse resource is not a private regular file.");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !sameFileMutationFingerprint(stat, opened) ||
      stat.mode !== opened.mode ||
      stat.uid !== opened.uid ||
      stat.gid !== opened.gid ||
      !opened.isFile() ||
      opened.nlink !== 1n
    ) {
      throw new Error("Reverse file descriptor does not match its captured inode.");
    }
    // Metadata and bytes come from this SAME opened file. A pathname can be
    // replaced and restored while its parent retains the original identity.
    const { sha256, sizeBytes } = hashFileDescriptorSync(fd, 1024 * 1024 * 1024);
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (
      !sameFileMutationFingerprint(opened, after) ||
      !sameFileMutationFingerprint(after, named) ||
      Number(opened.size) !== sizeBytes
    ) {
      throw new Error("Reverse resource changed while hashing its descriptor.");
    }
    return { kind: "file", ...metadata, sha256, size: sizeBytes };
  } finally {
    fs.closeSync(fd);
  }
}
export async function assertPackageReverseImage(
  file: string,
  expected: PackageActivationReverseImage,
  descriptor: PackageActivationDescriptor,
  externalExecutable = false,
) {
  const logical =
    expected.kind === "package"
      ? expected.identity === descriptor.previous.identity
        ? descriptor.authority.installKey
        : descriptor.originalStageRoot
      : undefined;
  if (
    !isDeepStrictEqual(await readPackageReverseImage(file, logical, externalExecutable), expected)
  ) {
    throw new Error(`Reverse resource preimage/postimage changed: ${file}`);
  }
}
function assertReverseParent(file: string, identity: string) {
  const parent = path.dirname(file);
  const stat = fs.lstatSync(parent, { bigint: true });
  if (
    !stat.isDirectory() ||
    fs.realpathSync(parent) !== parent ||
    `${stat.dev}:${stat.ino}` !== identity
  ) {
    throw new Error("Reverse resource parent changed.");
  }
}
export function assertReverseParents(resource: PackageActivationReverseResource) {
  let source = resource.live;
  if (
    resource.role === "state" &&
    resource.before.kind === "missing" &&
    resource.after.kind === "missing" &&
    !resource.move
  ) {
    // Unchanged absence creates no directory or inode. Retain the capture's
    // nearest existing ancestor; a newly created closer parent must not match.
    for (;;) {
      const parent = path.dirname(source);
      if (fs.lstatSync(parent, { throwIfNoEntry: false })) {
        break;
      }
      if (parent === source) {
        throw new Error("Reverse resource parent changed.");
      }
      source = parent;
    }
  }
  assertReverseParent(source, resource.parentIdentity);
  if (resource.move) {
    assertReverseParent(resource.move.staged, resource.move.stagedParentIdentity);
    assertReverseParent(resource.move.displaced, resource.move.displacedParentIdentity);
    if (
      [resource.move.stagedParentIdentity, resource.move.displacedParentIdentity].some(
        (id) => id.split(":")[0] !== resource.parentIdentity.split(":")[0],
      )
    ) {
      throw new Error("Reverse publication requires same-device renames.");
    }
  }
  return path.dirname(source);
}

/** Make newly staged inode contents and their names durable before the journal
 * can promise a resumable move. B/C/T payloads are never renamed or rewritten. */
export async function syncPackageReverseInputs(
  resources: readonly PackageActivationReverseResource[],
  assertCurrent: () => void,
  generations: readonly { directory: string; files: readonly string[] }[],
  recoveryFiles: readonly string[],
) {
  let entries = 0;
  const sync = async (file: string): Promise<void> => {
    assertCurrent();
    if (++entries > 100_000) {
      throw new Error("Reverse durability inventory exceeds its bound.");
    }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) {
        await sync(path.join(file, name));
      }
      requireDirectorySync(await syncDirectory(file), "Reverse staged directory");
    } else if (stat.isFile()) {
      const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new Error("Unsupported reverse durability object.");
    }
    assertCurrent();
  };
  // A name is durable only when every ancestor entry is durable. The filesystem
  // root is the established anchor; caller-created intermediate dirs are not.
  const parents = new Set<string>();
  const includeParents = (file: string, firstDirectory = path.dirname(file)) => {
    for (let directory = firstDirectory; ; directory = path.dirname(directory)) {
      parents.add(directory);
      if (directory === path.dirname(directory)) {
        break;
      }
    }
  };
  for (const generation of generations) {
    for (const file of generation.files) {
      await sync(file);
      includeParents(file);
    }
  }
  for (const file of recoveryFiles) {
    await sync(file);
    includeParents(file);
  }
  for (const resource of resources) {
    const liveParent = assertReverseParents(resource);
    // Unchanged directory contents have their own exhaustive resource records;
    // do not traverse excluded subtrees or synchronize them by implication.
    if (!resource.move && resource.after.kind === "directory") {
      requireDirectorySync(await syncDirectory(resource.live), "Reverse unchanged directory");
    } else {
      await sync(resource.live);
    }
    if (resource.move) {
      await sync(resource.move.staged);
    }
    for (const file of [
      resource.live,
      ...(resource.move ? [resource.move.staged, resource.move.displaced] : []),
    ]) {
      includeParents(file, file === resource.live ? liveParent : undefined);
    }
  }
  for (const directory of [...parents].toSorted((a, b) => b.length - a.length)) {
    assertCurrent();
    requireDirectorySync(await syncDirectory(directory), "Reverse durable ancestry");
    assertCurrent();
  }
  for (const resource of resources) {
    assertReverseParents(resource);
  }
}
