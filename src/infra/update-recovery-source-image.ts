import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

// These are physical stopped-source images, NOT SQLite snapshot payload digests.
// The caller must hold the continuing ORIGINAL publication maintenance throughout
// capture and verification. A released baseline capture guard is not sufficient.
type Metadata = {
  identity: string;
  mode: number;
  uid: string;
  gid: string;
  nlink: string;
  mtimeNs: string;
  ctimeNs: string;
  birthtimeNs: string;
};
export type UpdateRecoverySourceImage =
  | { kind: "missing" }
  | (Metadata & { kind: "file"; sha256: string; size: number })
  | (Metadata & { kind: "directory"; children: string[] })
  | (Metadata & { kind: "symlink"; target: string });
export type UpdateRecoverySourceResource = {
  sourcePath: string;
  kind: UpdateRecoverySourceImage["kind"];
  sqlite?: boolean;
};
export type UpdateRecoverySourceInventory = {
  runId: string;
  operationId: string;
  resources: {
    sourcePath: string;
    ancestor: { path: string; identity: string };
    image: UpdateRecoverySourceImage;
    sidecars: { suffix: "-wal" | "-shm" | "-journal"; image: UpdateRecoverySourceImage }[];
  }[];
};
type CaptureParams = {
  runId: string;
  operationId: string;
  resources: readonly UpdateRecoverySourceResource[];
  /** Must synchronously assert the original stopped-C publication maintenance. */
  assertCurrent: () => void;
};
const suffixes = ["-wal", "-shm", "-journal"] as const;

async function stat(file: string) {
  try {
    return await fs.lstat(file, { bigint: true });
  } catch (error) {
    // SAFETY: fs.lstat rejects with a Node system error; only its optional code is read.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
function fingerprint(s: NonNullable<Awaited<ReturnType<typeof stat>>>) {
  return [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.ctimeNs, s.mtimeNs, s.birthtimeNs];
}
async function readAncestor(file: string, assertCurrent: () => void) {
  let ancestor = path.dirname(file);
  for (;;) {
    assertCurrent();
    const before = await stat(ancestor);
    if (before) {
      if (!before.isDirectory() || (await fs.realpath(ancestor)) !== ancestor) {
        throw new Error(`Aliased update recovery source ancestor: ${ancestor}`);
      }
      const after = await stat(ancestor);
      if (!after || before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error(`Update recovery source ancestor changed: ${ancestor}`);
      }
      assertCurrent();
      return { path: ancestor, identity: `${before.dev}:${before.ino}` };
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`Missing update recovery source ancestor: ${file}`);
    }
    ancestor = parent;
  }
}
async function readImage(
  file: string,
  assertCurrent: () => void,
): Promise<UpdateRecoverySourceImage> {
  assertCurrent();
  const before = await stat(file);
  if (!before) {
    assertCurrent();
    if (await stat(file)) {
      throw new Error(`Update recovery source appeared while reading: ${file}`);
    }
    assertCurrent();
    return { kind: "missing" };
  }
  const metadata: Metadata = {
    identity: `${before.dev}:${before.ino}`,
    mode: Number(before.mode & 0o7777n),
    uid: String(before.uid),
    gid: String(before.gid),
    nlink: String(before.nlink),
    mtimeNs: String(before.mtimeNs),
    ctimeNs: String(before.ctimeNs),
    birthtimeNs: String(before.birthtimeNs),
  };
  let image: UpdateRecoverySourceImage;
  if (before.isSymbolicLink()) {
    image = { kind: "symlink", ...metadata, target: await fs.readlink(file) };
  } else if (before.isDirectory()) {
    image = { kind: "directory", ...metadata, children: (await fs.readdir(file)).toSorted() };
  } else if (before.isFile()) {
    // Never follow a final-component replacement. fstat/lstat also bind the
    // descriptor to the inventoried inode before and after the entire hash.
    const handle = await fs.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      if (
        !isDeepStrictEqual(fingerprint(await handle.stat({ bigint: true })), fingerprint(before))
      ) {
        throw new Error(`Update recovery source changed before hashing: ${file}`);
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      for (;;) {
        assertCurrent();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
        if (!bytesRead) {
          break;
        }
        size += bytesRead;
        if (!Number.isSafeInteger(size) || BigInt(size) > before.size) {
          throw new Error(`Update recovery source grew while hashing: ${file}`);
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (
        BigInt(size) !== before.size ||
        !isDeepStrictEqual(fingerprint(await handle.stat({ bigint: true })), fingerprint(before))
      ) {
        throw new Error(`Update recovery source changed while hashing: ${file}`);
      }
      image = { kind: "file", ...metadata, size, sha256: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  } else {
    throw new Error(`Unsupported update recovery source: ${file}`);
  }
  const after = await stat(file);
  if (!after || !isDeepStrictEqual(fingerprint(before), fingerprint(after))) {
    throw new Error(`Update recovery source changed while reading: ${file}`);
  }
  assertCurrent();
  return image;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Capture physical images without opening live SQLite or changing its artifacts. */
export async function captureUpdateRecoverySourceInventory(
  params: CaptureParams,
): Promise<UpdateRecoverySourceInventory> {
  const { runId, operationId, assertCurrent } = params;
  assertCurrent();
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(runId) || !/^[a-zA-Z0-9_-]{1,128}$/u.test(operationId)) {
    throw new Error("Invalid update recovery source run/operation.");
  }
  // Detach caller-owned descriptors before any await.
  const inputs = params.resources
    .map((r) => ({ ...r }))
    .toSorted((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  const paths = inputs.flatMap((r) => [
    r.sourcePath,
    ...(r.sqlite ? suffixes.map((s) => r.sourcePath + s) : []),
  ]);
  if (
    new Set(paths).size !== paths.length ||
    inputs.some(
      (r) =>
        !path.isAbsolute(r.sourcePath) ||
        path.resolve(r.sourcePath) !== r.sourcePath ||
        (r.sqlite && r.kind !== "file" && r.kind !== "missing"),
    )
  ) {
    throw new Error("Invalid or aliased update recovery source inventory.");
  }
  const resources: UpdateRecoverySourceInventory["resources"] = [];
  for (const input of inputs) {
    const ancestor = await readAncestor(input.sourcePath, assertCurrent);
    const image = await readImage(input.sourcePath, assertCurrent);
    if (image.kind !== input.kind) {
      throw new Error(`Update recovery source kind changed: ${input.sourcePath}`);
    }
    const sidecars: UpdateRecoverySourceInventory["resources"][number]["sidecars"] = [];
    for (const suffix of input.sqlite ? suffixes : []) {
      const sidecar = await readImage(input.sourcePath + suffix, assertCurrent);
      if (sidecar.kind !== "missing" && (sidecar.kind !== "file" || image.kind === "missing")) {
        throw new Error(`Invalid update recovery source sidecar: ${input.sourcePath}${suffix}`);
      }
      sidecars.push({ suffix, image: sidecar });
    }
    if (!isDeepStrictEqual(ancestor, await readAncestor(input.sourcePath, assertCurrent))) {
      throw new Error(`Update recovery source ancestor changed: ${input.sourcePath}`);
    }
    resources.push({ sourcePath: input.sourcePath, ancestor, image, sidecars });
  }
  assertCurrent();
  return freeze({ runId, operationId, resources });
}

/** Run after snapshotting and fresh resource discovery, before manifest publication.
 * Also usable before reverse binding, but only while that SAME maintenance remains
 * held. Persist the original inventory; never replace it with this readback.
 */
export async function assertUpdateRecoverySourceInventory(
  expected: UpdateRecoverySourceInventory,
  params: CaptureParams,
): Promise<void> {
  params.assertCurrent();
  if (expected.runId !== params.runId || expected.operationId !== params.operationId) {
    throw new Error("Update recovery source names another run or operation.");
  }
  const actual = await captureUpdateRecoverySourceInventory(params);
  const normalize = (inventory: UpdateRecoverySourceInventory) => ({
    ...inventory,
    resources: inventory.resources.map((resource) => ({
      ...resource,
      image:
        resource.image.kind === "directory"
          ? (({
              nlink: _nlink,
              mtimeNs: _mtime,
              ctimeNs: _ctime,
              birthtimeNs: _birth,
              ...stable
            }) => stable)(resource.image)
          : resource.image,
    })),
  });
  if (!isDeepStrictEqual(normalize(actual), normalize(expected))) {
    throw new Error("Update recovery source changed after capture.");
  }
  params.assertCurrent();
}
