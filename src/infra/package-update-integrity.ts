import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { hasErrnoCode } from "./errors.js";
import { readPackageVersion } from "./package-json.js";
import * as fileHashing from "./package-update-integrity-hasher.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";

// The shared deadline bounds elapsed time. At ~200 bytes per entry, 500,000
// entries budget ~100 MB for observations and bound directory enumeration.
// Hashing streams bytes; 8 GiB bounds total input rather than a buffer allocation.
// Both allow roughly 10x a ~50,000-entry / ~570 MiB installation to grow without
// making ordinary package size a verification failure, while retaining finite caps.
const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 500_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LAUNCHER_BYTES = 1024 * 1024;
const SETTLED_CTIME_MARGIN_MS = 5_000;
const SETTLED_CTIME_MARGIN_NS = BigInt(SETTLED_CTIME_MARGIN_MS) * 1_000_000n;
const log = createSubsystemLogger("update/package-integrity");
let readerSequence = 0;

export type PackageIntegrityFingerprint = { digest: string; identity: string; version: string };
export type PackageDirectoryIdentity = Pick<PackageIntegrityFingerprint, "identity" | "version">;

type EntryObservation = { fields: Map<string, string>; retained: string; reusable: boolean };
// Observations live only as long as their in-process fingerprint; journals stay compact.
const observations = new WeakMap<PackageIntegrityFingerprint, Map<string, EntryObservation>>();

export class PackageIntegrityMismatchError extends Error {
  constructor(
    message: string,
    readonly differences: string[],
  ) {
    super(`${message}${differences.length ? ` Drift: ${differences.join("; ")}.` : ""}`);
  }
}

export function packageIntegrityDifferences(
  expected: PackageIntegrityFingerprint,
  actual: PackageIntegrityFingerprint,
): string[] {
  const before = observations.get(expected);
  const after = observations.get(actual);
  const differences: string[] = [];
  if (before && after) {
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(name);
      const right = after.get(name);
      if (left?.retained === right?.retained) {
        continue;
      }
      const fields = !left
        ? ["added"]
        : !right
          ? ["removed"]
          : [...new Set([...left.fields.keys(), ...right.fields.keys()])].filter(
              (field) => left.fields.get(field) !== right.fields.get(field),
            );
      const entry = name.length > 90 ? `${name.slice(0, 87)}...` : name || ".";
      differences.push(
        `Package rollback entry ${JSON.stringify(entry)}: fields=${fields.join(",")}`,
      );
      if (differences.length === 5) {
        break;
      }
    }
  }
  return differences;
}

export type PackageLauncherFingerprint = {
  type: "symlink" | "file";
  mode: string;
  uid: string;
  gid: string;
  contents: string;
};

export function packageLauncherDifferences(
  expected: PackageLauncherFingerprint,
  actual: PackageLauncherFingerprint,
  options?: { checkMode?: boolean },
): string[] {
  const symlink = expected.type === "symlink" && actual.type === "symlink";
  // A copied launcher must restore the same bytes or link target; npm may
  // recreate its metadata. Exact-object mutation authority is checked separately.
  return (["type", "mode", "contents"] as const)
    .filter(
      (field) =>
        (field !== "mode" || options?.checkMode === true) && expected[field] !== actual[field],
    )
    .map((field) =>
      field === "contents" && symlink
        ? `target (expected ${JSON.stringify(expected.contents)}, actual ${JSON.stringify(actual.contents)})`
        : field,
    );
}

export class PackageIntegrityTimeoutError extends Error {
  constructor(readonly budgetMs: number) {
    super("Package rollback verification timed out");
  }
}

/** Resource exhaustion is distinct from a filesystem-integrity failure. */
export class PackageIntegrityLimitError extends Error {
  constructor(readonly resource: "entry" | "byte") {
    super(`Package rollback verification ${resource} limit exceeded`);
  }
}

export function isPackageIntegrityResourceError(
  error: unknown,
): error is PackageIntegrityTimeoutError | PackageIntegrityLimitError {
  return (
    error instanceof PackageIntegrityTimeoutError || error instanceof PackageIntegrityLimitError
  );
}

export type PackageRootIntegrityFingerprint =
  | { kind: "directory"; tree: PackageIntegrityFingerprint }
  | { kind: "link"; metadata: string[]; target: string };

export async function readPackageVersionIfPresent(
  packageRoot: string | null,
): Promise<string | null> {
  return packageRoot ? readPackageVersion(packageRoot) : null;
}

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function metadata(stat: BigIntStats) {
  return {
    "dev:ino": identity(stat),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

export function packageStatUnchanged(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Read-only, bounded observations. These do not exclude writers or seal an inode. */
export function createPackageIntegrityReader(timeoutMs = UPDATE_RUNNER_TIMEOUT_MS) {
  const startedAtMonotonicMs = performance.now();
  const budget = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : UPDATE_RUNNER_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  const timing = {
    readerId: `${process.pid}:${++readerSequence}`,
    timeOriginUnixMs: performance.timeOrigin,
    startedAtMonotonicMs,
    budgetMs: budget,
    deadlineClock: "wall",
    deadlineAtUnixMs: deadline,
  };
  let timeoutObservedAtMonotonicMs: number | undefined;
  let pendingIo = 0;

  async function trackIo<T>(operation: () => Promise<T>): Promise<T> {
    pendingIo++;
    try {
      return await operation();
    } finally {
      pendingIo--;
    }
  }

  async function observe<T>(
    phase: "baseline" | "retained" | "restored" | "transaction",
    operation: () => Promise<T>,
  ): Promise<T> {
    const emit = (event: string, facts?: Record<string, unknown>) => {
      try {
        log.debug(event, { ...timing, phase, event, ...facts });
      } catch {
        // A diagnostics sink must not replace the package result or primary error.
      }
    };
    emit("reader-started");
    let outcome = "failed";
    try {
      const result = await operation();
      outcome = "completed";
      return result;
    } finally {
      // Observe the completed scope, including its awaited cleanup, not merely
      // the timeout notification. Uncancelable OS work can still be pending.
      const settledAtMonotonicMs = performance.now();
      emit("reader-settled", {
        settledAtMonotonicMs,
        elapsedMs: settledAtMonotonicMs - startedAtMonotonicMs,
        outcome: timeoutObservedAtMonotonicMs === undefined ? outcome : "timed-out",
        timeoutObservedAtMonotonicMs,
        pendingIo,
      });
    }
  }

  async function read<T>(operation: () => Promise<T>, closeLate?: (value: T) => Promise<void>) {
    let pending: Promise<T> | undefined;
    const value = await awaitWithinDeadline(() => (pending = trackIo(operation)), deadline);
    if (value === ABSOLUTE_DEADLINE_EXPIRED) {
      timeoutObservedAtMonotonicMs ??= performance.now();
      // An OS read cannot always be canceled. Close late descriptors and never
      // continue the walk after returning a timeout to the swap owner.
      if (pending && closeLate) {
        void pending
          .then(
            (late) => trackIo(() => closeLate(late)),
            () => {},
          )
          .catch(() => {});
      }
      throw new PackageIntegrityTimeoutError(budget);
    }
    return value;
  }

  async function close(resource: { close: () => Promise<void> }) {
    const closing = trackIo(() => resource.close()).catch(() => {});
    if ((await awaitWithinDeadline(() => closing, deadline)) === ABSOLUTE_DEADLINE_EXPIRED) {
      timeoutObservedAtMonotonicMs ??= performance.now();
    }
  }

  async function entries(directoryPath: string, limit = MAX_TREE_ENTRIES): Promise<string[]> {
    const directory = await read(
      () => fs.opendir(directoryPath),
      (late) => late.close(),
    );
    const children: string[] = [];
    try {
      while (true) {
        const child = await read(() => directory.read());
        if (!child) {
          break;
        }
        if (children.length >= limit) {
          throw new PackageIntegrityLimitError("entry");
        }
        children.push(child.name);
      }
    } finally {
      await close(directory);
    }
    return children.toSorted();
  }

  async function hashFile(
    file: string,
    stat: BigIntStats,
    remainingBytes: number,
    readBuffer?: Buffer,
  ) {
    if (!stat.isFile()) {
      throw new Error("Package rollback verification byte limit exceeded");
    }
    if (stat.size > BigInt(remainingBytes)) {
      throw new PackageIntegrityLimitError("byte");
    }
    const handle = await read(
      () => fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      (late) => late.close(),
    );
    try {
      if (!packageStatUnchanged(stat, await read(() => handle.stat({ bigint: true })))) {
        throw new Error("Package rollback file changed before reading");
      }
      const hash = createHash("sha256");
      const buffer = readBuffer ?? Buffer.allocUnsafe(64 * 1024);
      const size = Number(stat.size);
      let position = 0;
      // The final stat detects growth; an extra EOF read costs one OS call per file.
      while (position < size) {
        const { bytesRead } = await read(() =>
          handle.read(buffer, 0, Math.min(buffer.length, size - position), position),
        );
        if (bytesRead === 0) {
          throw new Error("Package rollback file changed while reading");
        }
        position += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (!packageStatUnchanged(stat, await read(() => handle.stat({ bigint: true })))) {
        throw new Error("Package rollback file changed while reading");
      }
      return { digest: hash.digest("hex"), bytes: position };
    } finally {
      await close(handle);
    }
  }

  async function tree(
    root: string,
    originalRoot = root,
    reuse?: PackageIntegrityFingerprint,
    legacy = false,
  ): Promise<PackageIntegrityFingerprint> {
    const prior = reuse ? observations.get(reuse) : undefined;
    const digest = createHash("sha256");
    const observed: Array<{ file: string; stat: BigIntStats }> = [];
    const entriesObserved = new Map<string, EntryObservation>();
    let bytes = 0;
    let remainingEntries = MAX_TREE_ENTRIES - 1;
    let device: bigint | undefined;
    let rootIdentity = "";
    type HashedEntry = {
      relative: string;
      fields: Map<string, string>;
      retained: string[];
      reusable: boolean;
    };
    type Outcome = { entry: HashedEntry } | { error: unknown };
    // DFS post-order: settled entries (reused files, directories, links) wait only
    // behind earlier hashes, then drain with them.
    const pending: Array<{ entry: HashedEntry } | { outcome: Promise<Outcome> }> = [];
    const hasher = fileHashing.createPackageFileHasher(
      async (file, stat) => (await hashFile(file, stat, Number(stat.size))).digest,
    );
    const window = 64;
    let pendingFiles = 0;
    let fileFailed = false;
    const appendEntry = ({ relative, fields, retained, reusable }: HashedEntry) => {
      const retainedEntry = JSON.stringify([relative, retained]);
      if (!legacy) {
        digest.update(retainedEntry);
      }
      entriesObserved.set(relative, { fields, retained: retainedEntry, reusable });
    };
    const settled = (entry: HashedEntry) => {
      if (pending.length) {
        pending.push({ entry });
      } else {
        appendEntry(entry);
      }
    };
    const drainFiles = async (limit = pending.length) => {
      let count = limit;
      if (!count) {
        return;
      }
      const settle = (items: typeof pending) =>
        read(() => {
          hasher.flush();
          return Promise.all(
            items.map((item) => ("outcome" in item ? item.outcome : Promise.resolve(item))),
          );
        });
      let outcomes = await settle(pending.slice(0, count));
      if (count < pending.length && outcomes.some((outcome) => "error" in outcome)) {
        count = pending.length;
        outcomes = await settle(pending);
      }
      for (let next = pending[count]; next && "entry" in next; next = pending[++count]) {
        outcomes.push(next);
      }
      pendingFiles -= pending.splice(0, count).filter((item) => "outcome" in item).length;
      // Journal digests and refusal precedence follow DFS order, not IO completion order.
      for (const outcome of outcomes) {
        if ("error" in outcome) {
          throw outcome.error;
        }
        appendEntry(outcome.entry);
      }
    };

    async function visit(file: string, relative: string): Promise<void> {
      if (fileFailed) {
        await drainFiles();
      }
      const stat = await read(() => fs.lstat(file, { bigint: true }));
      if (fileFailed) {
        await drainFiles();
      }
      if (stat.ino === 0n || (device !== undefined && device !== stat.dev)) {
        throw new Error("Package rollback filesystem identity is unavailable");
      }
      if (!relative) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Package rollback root is not a retained directory");
        }
        device = stat.dev;
        rootIdentity = identity(stat);
      }
      observed.push({ file, stat });
      // npm's disposable hidden lockfile is a cache, not package content:
      // https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json#hidden-lockfiles
      // Keep the observation so a mid-scan substitution still refuses recovery.
      if (
        !legacy &&
        stat.isFile() &&
        /(?:^|\/)node_modules\/\.package-lock\.json$/u.test(relative)
      ) {
        return;
      }
      const info = metadata(stat);
      const fields = new Map(Object.entries(info));
      // npm bin repair chmods files; external hardlink removal changes nlink/ctime.
      // Keep inode, permissions and hashes strict; directory clocks/size also
      // change when npm replaces its hidden cache. Within-read checks stay strict.
      const retained = [info["dev:ino"], info.mode, info.uid, info.gid];
      if (!stat.isDirectory()) {
        retained.push(info.size, info.mtimeNs);
      }
      if (stat.isSymbolicLink()) {
        const target = await read(() => fs.readlink(file));
        const resolved = path.relative(
          originalRoot,
          path.resolve(path.dirname(path.join(originalRoot, relative)), target),
        );
        // Reject segment/.. after a non-parent component: a symlink there can
        // make lexical normalization disagree with filesystem traversal.
        let descended = false;
        for (const segment of target.split(/[\\/]+/)) {
          if (!segment || segment === ".") {
            continue;
          }
          if (segment === ".." && descended) {
            throw new Error("Package rollback symlink has ambiguous parent traversal");
          }
          descended ||= segment !== "..";
        }
        if (
          path.isAbsolute(resolved) ||
          resolved === ".." ||
          resolved.startsWith(`..${path.sep}`)
        ) {
          throw new Error("Package rollback symlink leaves the retained tree");
        }
        fields.set("target", target);
        retained.push("symlink", target);
      } else if (stat.isFile()) {
        const remainingBytes = MAX_TREE_BYTES - bytes;
        if (stat.size > BigInt(remainingBytes)) {
          throw new PackageIntegrityLimitError("byte");
        }
        bytes += Number(stat.size);
        const previous = prior?.get(relative);
        const previousDigest = previous?.fields.get("sha256");
        if (
          previous?.reusable &&
          previousDigest !== undefined &&
          Object.entries(info).every(([field, value]) => previous.fields.get(field) === value)
        ) {
          fields.set("sha256", previousDigest);
          retained.push("file", previousDigest);
          // Keep reused entries behind earlier hashes without consuming a hash slot.
          settled({ relative, fields, retained, reusable: true });
          return;
        }
        pendingFiles++;
        // Userspace cannot set ctime, but coarse filesystem clocks can hide same-tick
        // writes, so reuse only bytes read well after the last change; admission
        // precedes the worker or fallback read. Like the final sweep, this observes
        // rather than excludes writers: a store to an already dirty shared mapping
        // need not update timestamps.
        const admittedAtNs = BigInt(Date.now()) * 1_000_000n;
        const reusable = stat.ctimeNs + SETTLED_CTIME_MARGIN_NS <= admittedAtNs;
        pending.push({
          outcome: trackIo(() => hasher.hash(file, stat)).then(
            (fileDigest) => {
              fields.set("sha256", fileDigest);
              retained.push("file", fileDigest);
              return { entry: { relative, fields, retained, reusable } };
            },
            (error: unknown) => {
              fileFailed = true;
              return { error };
            },
          ),
        });
        if (pendingFiles === window) {
          await drainFiles(pending.findIndex((item) => "outcome" in item) + 1);
        }
        return;
      } else if (stat.isDirectory()) {
        const children = await entries(file, remainingEntries);
        // Reserve pending siblings before descending so wide ancestor lists
        // cannot each retain another full tree budget.
        remainingEntries -= children.length;
        for (const child of children) {
          await visit(path.join(file, child), relative ? `${relative}/${child}` : child);
        }
      } else {
        throw new Error("Package rollback contains a non-file entry");
      }
      settled({ relative, fields, retained, reusable: false });
    }

    try {
      try {
        await visit(root, "");
        await drainFiles();
      } catch (error) {
        // A deadline abandons OS work; all other refusals join admitted hashes
        // so a later walk error cannot hide an earlier DFS hash failure.
        if (!(error instanceof PackageIntegrityTimeoutError)) {
          await drainFiles();
        }
        throw error;
      }
      // JSON parsing buffers the manifest, unlike the streamed tree hash. Bound
      // that allocation separately, including growth after hashing.
      const version = await read(() => readPackageVersion(root, { maxBytes: MAX_MANIFEST_BYTES }));
      if (!version) {
        throw new Error("Package rollback version is unavailable");
      }
      for (const entry of observed) {
        if (
          !packageStatUnchanged(
            entry.stat,
            await read(() => fs.lstat(entry.file, { bigint: true })),
          )
        ) {
          throw new Error("Package rollback tree changed during verification");
        }
      }
      if (legacy) {
        for (const { file, stat } of observed) {
          const relative = path.relative(root, file).split(path.sep).join("/");
          const fields = entriesObserved.get(relative)!.fields;
          const info = Object.values(metadata(stat));
          if (!relative) {
            info.pop();
          }
          digest.update(JSON.stringify([relative, info]));
          const contents = fields.get("sha256");
          if (contents !== undefined) {
            const first =
              stat.nlink > 1n
                ? observed.find(
                    ({ stat: other }) => other.dev === stat.dev && other.ino === stat.ino,
                  )
                : undefined;
            const owner = first ? path.relative(root, first.file).split(path.sep).join("/") : null;
            digest.update(JSON.stringify(["file", owner, contents]));
          } else if (fields.has("target")) {
            digest.update(JSON.stringify(["symlink", fields.get("target")]));
          }
        }
      }
      const fingerprint = { digest: digest.digest("hex"), identity: rootIdentity, version };
      observations.set(fingerprint, entriesObserved);
      return fingerprint;
    } finally {
      hasher.close();
    }
  }

  async function rootEntry(
    root: string,
    originalRoot = root,
    expectedKind?: PackageRootIntegrityFingerprint["kind"],
  ): Promise<PackageRootIntegrityFingerprint> {
    const stat = await read(() => fs.lstat(root, { bigint: true }));
    if (expectedKind && expectedKind !== (stat.isSymbolicLink() ? "link" : "directory")) {
      throw new Error("Package rollback root entry kind changed");
    }
    if (!stat.isSymbolicLink()) {
      return { kind: "directory", tree: await tree(root, originalRoot) };
    }
    const target = await read(() => fs.readlink(root));
    if (!packageStatUnchanged(stat, await read(() => fs.lstat(root, { bigint: true })))) {
      throw new Error("Package rollback link changed while reading");
    }
    // npm owns this pointer, not the external checkout it names. A sibling
    // rename changes ctime but must preserve the link identity and raw target.
    return { kind: "link", metadata: Object.values(metadata(stat)).slice(0, -1), target };
  }

  async function directoryIdentity(root: string): Promise<PackageDirectoryIdentity | null> {
    const stat = await read(() => fs.lstat(root, { bigint: true }));
    if (stat.isSymbolicLink()) {
      return null;
    }
    if (!stat.isDirectory() || stat.ino === 0n) {
      throw new Error("Package rollback filesystem identity is unavailable");
    }
    const version = await read(() => readPackageVersion(root, { maxBytes: MAX_MANIFEST_BYTES }));
    if (
      !version ||
      !packageStatUnchanged(stat, await read(() => fs.lstat(root, { bigint: true })))
    ) {
      throw new Error("Package rollback identity changed or version is unavailable");
    }
    return { identity: identity(stat), version };
  }

  async function launcher(file: string): Promise<PackageLauncherFingerprint> {
    let stat = await read(() => fs.lstat(file, { bigint: true }));
    const symlink = stat.isSymbolicLink();
    const contents = symlink
      ? await read(() => fs.readlink(file))
      : (await hashFile(file, stat, MAX_LAUNCHER_BYTES)).digest;
    const current = await read(() => fs.lstat(file, { bigint: true }));
    if (symlink && current.isSymbolicLink()) {
      // npm can relink an equivalent bin while it is observed. Verify the raw
      // target again without following it, including when it is dangling.
      const target = await read(() => fs.readlink(file));
      if (target !== contents) {
        throw new Error(
          `Package rollback launcher target changed: ${file}; expected ${JSON.stringify(contents)}, actual ${JSON.stringify(target)}`,
        );
      }
      stat = current;
    } else if (!packageStatUnchanged(stat, current)) {
      throw new Error("Package rollback launcher changed during verification");
    }
    return {
      type: stat.isSymbolicLink() ? "symlink" : "file",
      mode: stat.mode.toString(),
      uid: stat.uid.toString(),
      gid: stat.gid.toString(),
      contents,
    };
  }

  async function exists(file: string): Promise<boolean> {
    try {
      await read(() => fs.lstat(file));
      return true;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  async function copiedTree(
    root: string,
    originalRoot: string,
    source: PackageIntegrityFingerprint,
  ): Promise<PackageIntegrityFingerprint> {
    const copied = await tree(root, originalRoot);
    const before = observations.get(source);
    const after = observations.get(copied);
    if (!before || !after) {
      throw new Error("Package copy verification requires the source inventory.");
    }
    // New inodes and timestamps are expected; bytes, links, permissions and
    // ownership must survive before the copy can become rollback custody.
    const fields = ["mode", "uid", "gid", "sha256", "target"];
    const matches =
      before.size === after.size &&
      [...before].every(([name, entry]) => {
        const actual = after.get(name);
        return (
          actual &&
          fields.every((field) => entry.fields.get(field) === actual.fields.get(field)) &&
          (!entry.fields.has("sha256") || entry.fields.get("size") === actual.fields.get("size"))
        );
      });
    if (!matches || source.version !== copied.version) {
      throw new Error("Package copy inventory does not match the original package.");
    }
    return copied;
  }

  return { tree, copiedTree, rootEntry, directoryIdentity, launcher, exists, entries, observe };
}
