import { EventEmitter } from "node:events";
import fs from "node:fs";
import promises from "node:fs/promises";
import path from "node:path";
import type { Result } from "@openclaw/normalization-core/result";
import { hasErrnoCode } from "../../infra/errno.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  createNativeSkillsAncestorWatcher,
  isNativeSkillsStructuralChange,
  SkillsNativeWatchInvalidatedError,
} from "./refresh-ancestor-native.js";
import { trackSkillsWatcherClose } from "./refresh-watch-close.js";
import { toWatchRoot, type createSkillsWatchPathFilter } from "./refresh-watch-path.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";

type NativeDirectory = {
  watcher: ReturnType<typeof createNativeSkillsAncestorWatcher>;
  entryParent: boolean;
};
type EntryKind = "directory" | "symlink";
type WatchedEntry = { kind: EntryKind; identity: fs.BigIntStats; target?: string };

function sameEntry(left: WatchedEntry | undefined, right: WatchedEntry | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.kind === right.kind &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    (left.kind === "directory" ||
      (left.identity.ctimeNs === right.identity.ctimeNs && left.target === right.target))
  );
}

function missing(error: unknown): boolean {
  return hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR");
}

function readSymlinkEntry(candidate: string, identity: fs.BigIntStats): WatchedEntry | undefined {
  if (!identity.isSymbolicLink()) {
    return undefined;
  }
  try {
    return { kind: "symlink", identity, target: fs.readlinkSync(candidate) };
  } catch (error) {
    // A listing or lstat can outlive the link. Restart admission instead of
    // publishing partial coverage or failing a healthy replacement directory.
    if (missing(error) || hasErrnoCode(error, "EINVAL")) {
      return undefined;
    }
    throw error;
  }
}

function sameDirectory(left: fs.BigIntStats | undefined, right: fs.BigIntStats): boolean {
  return (
    left !== undefined && right.isDirectory() && left.dev === right.dev && left.ino === right.ino
  );
}

class NativeSkillsContentWatcher extends EventEmitter implements SkillsDirectoryWatcher {
  closed = false;
  private failed = false;
  private ready = false;
  private dirty = false;
  private scanning?: Promise<void>;
  private closing?: Promise<Result<void, unknown>>;
  private readonly registrations = new Map<string, NativeDirectory>();
  private entries = new Map<string, WatchedEntry>();
  private readonly retired = new Set<Promise<Result<void, unknown>>>();
  private retirementFailure?: Result<void, unknown>;

  constructor(
    private readonly root: string,
    private readonly depth: number,
    private readonly ignored: ReturnType<typeof createSkillsWatchPathFilter>["ignored"],
  ) {
    super();
    // Let the logical owner attach listeners and publish this generation first.
    // Closing before this microtask must not acquire a native registration.
    queueMicrotask(() => this.rescan());
  }

  get directories(): ReadonlySet<string> {
    return new Set(this.registrations.keys());
  }

  private owns(directory: string, registration: NativeDirectory): boolean {
    return !this.closed && this.registrations.get(directory) === registration;
  }

  private retire(directory: string, descendants = true): void {
    for (const [candidate, registration] of this.registrations) {
      if (candidate !== directory && (!descendants || !isPathInside(directory, candidate))) {
        continue;
      }
      // Remove ownership before close or any external callback can reenter.
      this.registrations.delete(candidate);
      const closing = registration.watcher.close();
      this.retired.add(closing);
      void closing.then((result) => {
        if (!result.ok) {
          this.retirementFailure ??= result;
        }
        this.retired.delete(closing);
      });
    }
  }

  private acquire(
    directory: string,
    identity: fs.BigIntStats,
    entryParent: boolean,
  ): NativeDirectory {
    const previous = this.registrations.get(directory);
    if (previous && sameDirectory(previous.watcher.admittedIdentity, identity)) {
      return previous;
    }
    if (previous) {
      this.retire(directory);
    }
    const watcher = createNativeSkillsAncestorWatcher(
      directory,
      this.ignored,
      () => {
        if (this.owns(directory, registration)) {
          this.retire(directory);
          this.rescan();
        }
      },
      entryParent ? "entry-parent" : "directory",
    );
    const registration = { watcher, entryParent };
    // The shallow native owner acquires synchronously. Retain it before the
    // first directory read, so startup close never depends on scan completion.
    this.registrations.set(directory, registration);
    watcher.on("reconcile", (changedPath: string, structural: boolean) => {
      if (
        !this.owns(directory, registration) ||
        (!structural && !this.entries.has(toWatchRoot(changedPath)))
      ) {
        return;
      }
      // A filtered native spelling cannot carry the raw revision. Dirty the
      // logical generation before scanning so an older verifier cannot promote.
      this.emit("dirty");
      if (this.owns(directory, registration)) {
        this.rescan();
      }
    });
    watcher.on("all", (event: string, changedPath: string) => {
      if (!this.owns(directory, registration)) {
        return;
      }
      if (event === "ancestor" && changedPath === directory) {
        // A same-shaped replacement still invalidates discovery. Raw file
        // events alone only invalidate supporting content in the logical owner.
        this.emit("all", "unlinkDir", directory);
      } else if (event === "change" && this.isStructuralChange(changedPath)) {
        this.rescan();
      }
    });
    watcher.on("raw", (event: string, filename: unknown, details: unknown) => {
      if (!this.owns(directory, registration)) {
        return;
      }
      this.emit("raw", event, filename, details);
      if (this.owns(directory, registration) && (event !== "change" || !filename)) {
        this.rescan();
      }
    });
    watcher.on("error", (error: unknown) => {
      if (this.owns(directory, registration)) {
        this.retire(directory);
        if (
          !entryParent &&
          directory !== this.root &&
          (missing(error) || error instanceof SkillsNativeWatchInvalidatedError)
        ) {
          // A child can disappear or change kind/inode after its scan snapshot.
          // Its parent still observes replacement and sibling work.
          this.rescan();
        } else {
          this.fail(error);
        }
      }
    });
    return registration;
  }

  private isStructuralChange(changedPath: string): boolean {
    return (
      this.entries.has(toWatchRoot(changedPath)) || isNativeSkillsStructuralChange(changedPath)
    );
  }

  private fail(error: unknown): void {
    if (!this.closed) {
      this.failed = true;
      this.emit("error", error);
    }
  }

  private readRootState(): fs.BigIntStats | undefined {
    try {
      return fs.lstatSync(this.root, { bigint: true });
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
      const parent = toWatchRoot(path.dirname(this.root));
      const registration = this.registrations.get(parent);
      const admittedIdentity = registration?.watcher.admittedIdentity;
      if (!registration?.entryParent || !this.owns(parent, registration) || !admittedIdentity) {
        throw error;
      }
      // An empty prior inventory cannot authorize another missing leaf. Its
      // still-owned parent must retain the identity admitted for observation.
      if (!sameDirectory(admittedIdentity, fs.statSync(parent, { bigint: true }))) {
        throw new SkillsNativeWatchInvalidatedError(
          `Skills entry observation changed before root reconciliation: ${parent}`,
        );
      }
      return undefined;
    }
  }

  private async scan(): Promise<void> {
    const discovered = new Map<string, WatchedEntry>();
    const announced = new Set<string>();
    const visited = new Map<string, NativeDirectory>();
    const rootState = this.readRootState();
    // Logical symlinks are observation-only. Target preparation separately
    // admits trusted realpaths; watching the link itself would follow it.
    const entryParent = !rootState?.isDirectory();
    const rootDirectory = entryParent ? toWatchRoot(path.dirname(this.root)) : this.root;
    const queue: Array<{
      directory: string;
      depth: number;
      parent?: { directory: string; registration: NativeDirectory };
    }> = [{ directory: rootDirectory, depth: 0 }];
    for (const current of queue) {
      // A sibling read can outlive this branch's namespace. A structural event
      // invalidates queued paths even when their admitting owner is still open.
      if (
        this.closed ||
        this.dirty ||
        (current.parent && !this.owns(current.parent.directory, current.parent.registration))
      ) {
        return;
      }
      const { directory, depth } = current;
      let identity: fs.BigIntStats;
      try {
        identity = entryParent
          ? fs.statSync(directory, { bigint: true })
          : fs.lstatSync(directory, { bigint: true });
      } catch (error) {
        if (directory !== rootDirectory && missing(error)) {
          continue;
        }
        throw error;
      }
      if (!identity.isDirectory()) {
        if (entryParent) {
          throw new Error(`Skills entry observation requires a directory: ${directory}`);
        }
        if (directory === rootDirectory) {
          this.dirty = true;
          return;
        }
        continue;
      }
      if (this.ignored(directory, identity)) {
        continue;
      }
      const registration = this.acquire(directory, identity, entryParent);
      // Constructor errors publish in a microtask. Do not list a rejected path
      // while that queued error still owns retirement and the next scan.
      const admittedIdentity = registration.watcher.admittedIdentity;
      if (!admittedIdentity) {
        return;
      }
      visited.set(directory, registration);
      if (entryParent) {
        // Capture the logical entry under its parent observer. A pre-watch
        // snapshot could otherwise certify parent-only coverage for a new tree.
        const currentRoot = this.readRootState();
        if (currentRoot?.isDirectory()) {
          this.dirty = true;
          return;
        }
        if (currentRoot?.isSymbolicLink() && !this.ignored(this.root, currentRoot)) {
          const entry = readSymlinkEntry(this.root, currentRoot);
          if (!entry) {
            this.dirty = true;
            return;
          }
          discovered.set(this.root, entry);
        }
        // A present leaf can survive a parent alias switching away and back.
        // Its inventory must belong to the parent admitted before this read.
        if (
          currentRoot &&
          !sameDirectory(admittedIdentity, fs.statSync(directory, { bigint: true }))
        ) {
          this.retire(directory);
          this.dirty = true;
          return;
        }
        continue;
      }
      // Admission can observe a replacement after the scanner's first stat.
      // Both inventory and the post-read check belong to that native identity.
      const directoryEntry: WatchedEntry = { kind: "directory", identity: admittedIdentity };
      discovered.set(directory, directoryEntry);
      if (this.ready && !sameEntry(this.entries.get(directory), directoryEntry)) {
        // Live discovery publishes only after the child's disposer is owned.
        // Initial and verification listings retain their ready-time fan-in.
        announced.add(directory);
        this.emit("all", "addDir", directory);
        if (this.dirty || !this.owns(directory, registration)) {
          return;
        }
      }
      // Capture each listing only after its parent has continuous observation.
      // A mutation during the await dirties this scan before ready can publish.
      let children: fs.Dirent[] | undefined;
      try {
        children = await promises.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!this.owns(directory, registration)) {
          return;
        }
        if (!missing(error)) {
          throw error;
        }
      }
      // Settle an owned read's errors before discarding an invalidated scan.
      // Its remaining pathnames no longer authorize probing or admission.
      if (this.dirty || !this.owns(directory, registration)) {
        return;
      }
      let after: fs.BigIntStats;
      try {
        after = fs.lstatSync(directory, { bigint: true });
      } catch (error) {
        if (!missing(error)) {
          throw error;
        }
        discovered.delete(directory);
        visited.delete(directory);
        this.retire(directory);
        if (this.ready) {
          this.emit("all", "unlinkDir", directory);
        }
        if (directory === rootDirectory) {
          this.dirty = true;
          return;
        }
        continue;
      }
      if (!sameDirectory(admittedIdentity, after)) {
        this.retire(directory);
        this.dirty = true;
        return;
      }
      if (!children) {
        // Dirent conversion can fail on a vanished child of a healthy directory.
        // Keep its observation until a complete listing can replace the inventory.
        this.dirty = true;
        return;
      }
      for (const child of children) {
        const candidate = toWatchRoot(path.join(directory, child.name));
        if (this.ignored(candidate, child)) {
          continue;
        }
        if (child.isSymbolicLink()) {
          try {
            const entry = readSymlinkEntry(candidate, fs.lstatSync(candidate, { bigint: true }));
            if (!entry) {
              this.dirty = true;
              return;
            }
            discovered.set(candidate, entry);
          } catch (error) {
            if (!missing(error)) {
              throw error;
            }
          }
        } else if (child.isDirectory() && depth < this.depth) {
          queue.push({
            directory: candidate,
            depth: depth + 1,
            parent: { directory, registration },
          });
        }
      }
    }
    if (this.closed || this.dirty) {
      return;
    }
    // Empty or link-only branches may have no queued child to reject. Their
    // retired registrations cannot authorize this scan's inventory either.
    for (const [directory, registration] of visited) {
      if (!this.owns(directory, registration)) {
        return;
      }
    }
    for (const directory of this.registrations.keys()) {
      if (!visited.has(directory)) {
        // A former entry-parent can enclose newly admitted root registrations.
        // Pruning stale owners must preserve this scan's verified descendants.
        this.retire(directory, false);
      }
    }
    const previous = this.entries;
    this.entries = discovered;
    if (this.ready) {
      for (const [entry, fact] of previous) {
        if (!announced.has(entry) && !sameEntry(discovered.get(entry), fact)) {
          // Retargeting keeps the same logical link. A synthetic unlink would
          // erase the filter's directory identity before its later real removal.
          if (fact.kind === "symlink" && discovered.get(entry)?.kind === "symlink") {
            continue;
          }
          this.emit("all", fact.kind === "directory" ? "unlinkDir" : "unlink", entry);
          if (this.closed) {
            return;
          }
        }
      }
      for (const [entry, fact] of discovered) {
        if (!announced.has(entry) && !sameEntry(previous.get(entry), fact)) {
          const event =
            fact.kind === "directory"
              ? "addDir"
              : previous.get(entry)?.kind === "symlink"
                ? "change"
                : "add";
          this.emit("all", event, entry);
          if (this.closed) {
            return;
          }
        }
      }
    }
  }

  private rescan(): void {
    if (this.closed) {
      return;
    }
    this.dirty = true;
    if (this.scanning) {
      return;
    }
    this.scanning = (async () => {
      try {
        while (this.dirty && !this.closed) {
          this.dirty = false;
          await this.scan();
        }
        if (!this.closed && !this.failed && !this.ready) {
          this.ready = true;
          this.emit("ready");
        }
      } catch (error) {
        this.fail(error);
      } finally {
        this.scanning = undefined;
      }
    })();
  }

  close(): Promise<Result<void, unknown>> {
    if (this.closing) {
      return this.closing;
    }
    this.closed = true;
    this.removeAllListeners();
    for (const directory of this.registrations.keys()) {
      this.retire(directory);
    }
    const scanning = this.scanning;
    this.closing = trackSkillsWatcherClose(async () => {
      await scanning;
      await Promise.all(this.retired);
      const failed = this.retirementFailure;
      if (failed && !failed.ok) {
        throw failed.error;
      }
    });
    return this.closing;
  }
}

export function createNativeSkillsContentWatcher(
  root: string,
  options: {
    depth: number;
    ignored: ReturnType<typeof createSkillsWatchPathFilter>["ignored"];
  },
): SkillsDirectoryWatcher {
  return new NativeSkillsContentWatcher(root, options.depth, options.ignored);
}
