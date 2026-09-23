import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { hasErrnoCode } from "./errors.js";
import { readPackageVersion } from "./package-json.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";

const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LAUNCHER_BYTES = 1024 * 1024;
const MIN_ROLLBACK_SCAN_MS = 120_000;
const MAX_ROLLBACK_SCAN_MS = 45 * 60_000;
const log = createSubsystemLogger("update/package-integrity");
let readerSequence = 0;

export type PackageIntegrityFingerprint = { digest: string; identity: string; version: string };
export type PackageDirectoryIdentity = Pick<PackageIntegrityFingerprint, "identity" | "version">;

type PackageRollbackEntry = {
  relative: string;
  metadata: string[];
  children?: string[];
  target?: string;
  digest?: string;
};

type PackageRollbackFingerprint = PackageDirectoryIdentity & {
  entries: PackageRollbackEntry[];
  complete: boolean;
  warning?: string;
};

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
  ownershipPreserved = true,
): string[] {
  const symlink = expected.type === "symlink" && actual.type === "symlink";
  return (["type", "mode", "uid", "gid", "contents"] as const)
    .filter(
      (field) =>
        !(
          symlink &&
          (field === "mode" || (!ownershipPreserved && (field === "uid" || field === "gid")))
        ) && expected[field] !== actual[field],
    )
    .map((field) => (field === "contents" && symlink ? "target" : field));
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

export type PackageRootIntegrityFingerprint =
  | { kind: "directory"; tree: PackageRollbackFingerprint }
  | { kind: "link"; metadata: string[]; target: string };

export async function readPackageVersionIfPresent(
  packageRoot: string | null,
): Promise<string | null> {
  return packageRoot ? readPackageVersion(packageRoot) : null;
}

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function metadata(stat: BigIntStats): string[] {
  return [
    identity(stat),
    stat.mode.toString(),
    stat.uid.toString(),
    stat.gid.toString(),
    stat.nlink.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
  ];
}

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && metadata(left).join("/") === metadata(right).join("/");
}

function assertRetainedLink(originalRoot: string, relative: string, target: string) {
  const resolved = path.relative(
    originalRoot,
    path.resolve(path.dirname(path.join(originalRoot, relative)), target),
  );
  // A symlink before /.. can make lexical normalization disagree with traversal.
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
  if (path.isAbsolute(resolved) || resolved === ".." || resolved.startsWith(`..${path.sep}`)) {
    throw new Error("Package rollback symlink leaves the retained tree");
  }
}

function rollbackReadPriority(relative: string): number {
  if (relative === "package.json") {
    return 0;
  }
  if (relative.split("/").includes("node_modules")) {
    return 3;
  }
  if (relative.startsWith("docs/") || relative.endsWith(".map")) {
    return 2;
  }
  return 1;
}

/** Read-only, bounded observations. These do not exclude writers or seal an inode. */
export function createPackageIntegrityReader(
  timeoutMs = UPDATE_RUNNER_TIMEOUT_MS,
  options?: { mode: "recovery"; warn: (message: string) => void },
) {
  const startedAtMonotonicMs = performance.now();
  let budget = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : UPDATE_RUNNER_TIMEOUT_MS;
  const startedAt = Date.now();
  let deadline = startedAt + budget;
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
  const finishRequiredReads = options?.mode === "recovery";

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
        log.debug(event, {
          ...timing,
          budgetMs: budget,
          deadlineAtUnixMs: deadline,
          phase,
          event,
          ...facts,
        });
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
        outcome:
          timeoutObservedAtMonotonicMs === undefined
            ? outcome
            : finishRequiredReads
              ? `${outcome}-over-budget`
              : "timed-out",
        timeoutObservedAtMonotonicMs,
        pendingIo,
      });
    }
  }

  async function read<T>(operation: () => Promise<T>, closeLate?: (value: T) => Promise<void>) {
    let pending: Promise<T> | undefined;
    const value = await awaitWithinDeadline(() => (pending = trackIo(operation)), deadline);
    if (value === ABSOLUTE_DEADLINE_EXPIRED) {
      const firstTimeout = timeoutObservedAtMonotonicMs === undefined;
      timeoutObservedAtMonotonicMs ??= performance.now();
      if (finishRequiredReads) {
        // Recovery cannot discard an already-recorded fingerprint. Finish its
        // read before the owner can replace the candidate; only capture is optional.
        if (firstTimeout) {
          options.warn(
            `Package rollback verification exceeded ${budget / 1000} s; continuing recorded fingerprint checks before replacing the installation.`,
          );
        }
        return await (pending ?? trackIo(operation));
      }
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
    if (finishRequiredReads) {
      await closing;
      return;
    }
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
    onRead?: (bytes: number) => void,
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
      if (!unchanged(stat, await read(() => handle.stat({ bigint: true })))) {
        throw new Error("Package rollback file changed before reading");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
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
        onRead?.(bytesRead);
      }
      if (!unchanged(stat, await read(() => handle.stat({ bigint: true })))) {
        throw new Error("Package rollback file changed while reading");
      }
      return { digest: hash.digest("hex"), bytes: position };
    } finally {
      await close(handle);
    }
  }

  async function tree(root: string, originalRoot = root): Promise<PackageIntegrityFingerprint> {
    const digest = createHash("sha256");
    const observed: Array<{ file: string; stat: BigIntStats }> = [];
    const hardlinks = new Map<string, string>();
    let bytes = 0;
    let remainingEntries = MAX_TREE_ENTRIES - 1;
    let device: bigint | undefined;
    let rootIdentity = "";

    async function visit(file: string, relative: string): Promise<void> {
      const stat = await read(() => fs.lstat(file, { bigint: true }));
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
      // Renaming changes the root ctime. All descendant identities and clocks
      // must survive; root identity is compared separately from this digest.
      const fields = metadata(stat);
      if (!relative) {
        fields.pop();
      }
      digest.update(JSON.stringify([relative, fields]));
      if (stat.isSymbolicLink()) {
        const target = await read(() => fs.readlink(file));
        assertRetainedLink(originalRoot, relative, target);
        digest.update(JSON.stringify(["symlink", target]));
      } else if (stat.isFile()) {
        const contents = await hashFile(file, stat, MAX_TREE_BYTES - bytes);
        bytes += contents.bytes;
        const key = identity(stat);
        const owner = stat.nlink > 1n ? (hardlinks.get(key) ?? relative) : null;
        if (owner !== null) {
          hardlinks.set(key, owner);
        }
        digest.update(JSON.stringify(["file", owner, contents.digest]));
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
    }

    await visit(root, "");
    // JSON parsing buffers the manifest, unlike the streamed tree hash. Bound
    // that allocation separately, including growth after hashing.
    const version = await read(() => readPackageVersion(root, { maxBytes: MAX_MANIFEST_BYTES }));
    if (!version) {
      throw new Error("Package rollback version is unavailable");
    }
    for (const entry of observed) {
      if (!unchanged(entry.stat, await read(() => fs.lstat(entry.file, { bigint: true })))) {
        throw new Error("Package rollback tree changed during verification");
      }
    }
    return { digest: digest.digest("hex"), identity: rootIdentity, version };
  }

  async function rollbackTree(
    root: string,
    originalRoot: string,
    expected?: PackageRollbackFingerprint,
  ): Promise<PackageRollbackFingerprint> {
    budget = MIN_ROLLBACK_SCAN_MS;
    deadline = startedAt + budget;
    // Identity and version are mandatory even if the optional inventory stalls.
    const initial = await directoryIdentity(root);
    if (!initial) {
      throw new Error("Package rollback root is not a retained directory");
    }
    const mismatch = (relative: string): never => {
      throw new Error(`Package rollback tree changed at ${path.join(root, relative)}`);
    };
    if (
      expected &&
      (initial.identity !== expected.identity || initial.version !== expected.version)
    ) {
      mismatch("");
    }
    const expectedEntries =
      expected && new Map(expected.entries.map((entry) => [entry.relative, entry]));
    const observed: Array<{ entry: PackageRollbackEntry; stat: BigIntStats }> = [];
    let totalBytes = 0;
    let remainingEntries = MAX_TREE_ENTRIES - 1;
    let device: bigint | undefined;
    const result: PackageRollbackFingerprint = { ...initial, entries: [], complete: false };

    async function visit(relative: string, recursive: boolean): Promise<void> {
      const file = path.join(root, relative);
      const stat = await read(() => fs.lstat(file, { bigint: true }));
      if (stat.ino === 0n || (device !== undefined && device !== stat.dev)) {
        throw new Error("Package rollback filesystem identity is unavailable");
      }
      device ??= stat.dev;
      const fields = metadata(stat);
      if (!relative) {
        if (!stat.isDirectory() || identity(stat) !== result.identity) {
          mismatch(relative);
        }
        fields.pop(); // The root's ctime changes on rename.
      }
      const entry: PackageRollbackEntry = { relative, metadata: fields };
      if (stat.isSymbolicLink()) {
        entry.target = await read(() => fs.readlink(file));
        assertRetainedLink(originalRoot, relative, entry.target);
      } else if (stat.isFile()) {
        totalBytes += Number(stat.size);
        if (totalBytes > MAX_TREE_BYTES) {
          throw new PackageIntegrityLimitError("byte");
        }
      } else if (!stat.isDirectory()) {
        throw new Error("Package rollback contains a non-file entry");
      }
      const previous = expectedEntries?.get(relative);
      if (
        expected &&
        (previous
          ? previous.metadata.join("/") !== fields.join("/") || previous.target !== entry.target
          : expected.complete)
      ) {
        mismatch(relative);
      }
      result.entries.push(entry);
      observed.push({ entry, stat });
      if (stat.isDirectory()) {
        const expectedChildren = previous?.children;
        if (recursive || expectedChildren) {
          const children = await entries(
            file,
            expectedChildren ? expectedChildren.length + 1 : remainingEntries,
          );
          if (
            expectedChildren &&
            (children.length !== expectedChildren.length ||
              children.some((child, index) => child !== expectedChildren[index]))
          ) {
            mismatch(relative);
          }
          entry.children = children;
          if (recursive) {
            remainingEntries -= children.length;
            for (const child of children) {
              await visit(relative ? `${relative}/${child}` : child, true);
            }
          }
        }
      }
    }

    try {
      if (expected) {
        // Unrecorded contents cannot be compared. Reopening the stalled remainder
        // would turn the optional baseline cutoff into mandatory recovery work.
        for (const previous of expected.entries) {
          await visit(previous.relative, false);
        }
      } else {
        await visit("", true);
      }
      const files = observed
        .filter(
          ({ entry, stat }) =>
            stat.isFile() &&
            (!expected || expectedEntries?.get(entry.relative)?.digest !== undefined),
        )
        .toSorted(
          (left, right) =>
            rollbackReadPriority(left.entry.relative) - rollbackReadPriority(right.entry.relative),
        );
      const hashBytes = files.reduce((sum, { stat }) => sum + Number(stat.size), 0);
      const hashStartedAt = Date.now();
      let hashedBytes = 0;
      let hashedFiles = 0;
      let sampled = false;
      const sample = (bytes: number) => {
        hashedBytes += bytes;
        const elapsed = Date.now() - hashStartedAt;
        if (!sampled && elapsed >= 1000) {
          sampled = true;
          // Use both rates: many tiny files are metadata-bound. Four times the
          // measured cost leaves room for cold disks, contention and the final stat pass.
          const projectedMs = Math.max(
            hashedBytes > 0 ? (hashBytes * elapsed) / hashedBytes : 0,
            (files.length * elapsed) / Math.max(1, hashedFiles),
          );
          budget = Math.min(
            MAX_ROLLBACK_SCAN_MS,
            Math.max(budget, hashStartedAt - startedAt + Math.ceil(projectedMs * 4)),
          );
          deadline = startedAt + budget;
        }
      };
      for (const { entry, stat } of files) {
        const contents = await hashFile(
          path.join(root, entry.relative),
          stat,
          MAX_TREE_BYTES,
          sample,
        );
        const previous = expectedEntries?.get(entry.relative);
        if (previous?.digest !== undefined && previous.digest !== contents.digest) {
          throw new Error(
            `Package rollback content hash mismatch at ${path.join(root, entry.relative)}`,
          );
        }
        entry.digest = contents.digest;
        hashedFiles++;
        sample(0);
      }
      for (const { entry, stat } of observed) {
        if (
          !unchanged(
            stat,
            await read(() => fs.lstat(path.join(root, entry.relative), { bigint: true })),
          )
        ) {
          mismatch(entry.relative);
        }
      }
      result.complete = expected?.complete ?? true;
    } catch (error) {
      if (!(error instanceof PackageIntegrityTimeoutError)) {
        throw error;
      }
      result.warning = `package fingerprint incomplete after ${budget / 1000} s; checked ${result.entries.filter((entry) => entry.digest !== undefined).length} file hashes; remaining contents unverified. Recovery requires the retained directory, version, launchers and completed fingerprints.`;
    }
    // A fresh mandatory observation cannot inherit the optional scan's deadline.
    const current = finishRequiredReads
      ? await directoryIdentity(root)
      : await createPackageIntegrityReader(
          Math.max(timeoutMs, MIN_ROLLBACK_SCAN_MS),
        ).directoryIdentity(root);
    if (!current || current.identity !== initial.identity || current.version !== initial.version) {
      mismatch("");
    }
    return result;
  }

  async function rootEntry(
    root: string,
    originalRoot = root,
    expectedKind?: PackageRootIntegrityFingerprint["kind"],
    expectedTree?: PackageRollbackFingerprint,
  ): Promise<PackageRootIntegrityFingerprint> {
    const stat = await read(() => fs.lstat(root, { bigint: true }));
    if (expectedKind && expectedKind !== (stat.isSymbolicLink() ? "link" : "directory")) {
      throw new Error("Package rollback root entry kind changed");
    }
    if (!stat.isSymbolicLink()) {
      return { kind: "directory", tree: await rollbackTree(root, originalRoot, expectedTree) };
    }
    const target = await read(() => fs.readlink(root));
    if (!unchanged(stat, await read(() => fs.lstat(root, { bigint: true })))) {
      throw new Error("Package rollback link changed while reading");
    }
    // npm owns this pointer, not the external checkout it names. A sibling
    // rename changes ctime but must preserve the link identity and raw target.
    return { kind: "link", metadata: metadata(stat).slice(0, -1), target };
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
    if (!version || !unchanged(stat, await read(() => fs.lstat(root, { bigint: true })))) {
      throw new Error("Package rollback identity changed or version is unavailable");
    }
    return { identity: identity(stat), version };
  }

  async function launcher(file: string): Promise<PackageLauncherFingerprint> {
    const stat = await read(() => fs.lstat(file, { bigint: true }));
    const contents = stat.isSymbolicLink()
      ? await read(() => fs.readlink(file))
      : (await hashFile(file, stat, MAX_LAUNCHER_BYTES)).digest;
    if (!unchanged(stat, await read(() => fs.lstat(file, { bigint: true })))) {
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

  return { tree, rootEntry, directoryIdentity, launcher, exists, entries, observe };
}
