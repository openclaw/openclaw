import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";

type Pin = { fd: number; stat: fs.BigIntStats; target: string };
type Scope = { pins: Map<string, Pin>; active: boolean };
const custody = new AsyncLocalStorage<Scope>();
const identity = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}`;
function same(left: fs.BigIntStats, right: fs.BigIntStats) {
  return (
    sameFileMutationFingerprint(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}
function observe(pin: Pin, file: string) {
  const before = fs.fstatSync(pin.fd, { bigint: true });
  if (!same(pin.stat, before) || before.nlink !== 1n) {
    throw new Error("Retained reverse symlink generation changed.");
  }
  const inodePath = `/.vol/${before.dev}/${before.ino}`;
  if (!same(before, fs.lstatSync(inodePath, { bigint: true }))) {
    throw new Error("Reverse symlink inode lookup changed.");
  }
  // O_SYMLINK pins the inode, but /dev/fd is not readlinkat(AT_EMPTY_PATH).
  // Darwin volfs addresses that pinned inode even through a parent-path ABA.
  const target = fs.readlinkSync(inodePath);
  const after = fs.fstatSync(pin.fd, { bigint: true });
  if (
    !same(before, after) ||
    !same(after, fs.lstatSync(file, { bigint: true })) ||
    Buffer.byteLength(target) !== Number(before.size)
  ) {
    throw new Error("Reverse symlink changed while reading its pinned inode.");
  }
  return target;
}

function observeNamedSymlink(initial: fs.BigIntStats, file: string): string {
  const before = fs.lstatSync(file, { bigint: true });
  if (!same(initial, before) || !before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error("Reverse symlink path does not match its captured inode.");
  }
  const target = fs.readlinkSync(file);
  const after = fs.lstatSync(file, { bigint: true });
  if (!same(before, after) || Buffer.byteLength(target) !== Number(before.size)) {
    throw new Error("Reverse symlink changed while reading its named inode.");
  }
  return target;
}

/** Observation lifetime only: the existing executor still owns every effect.
 * Keep pins through callback, child and command settlement, including handoff.
 * Pins are process-local and never passed to children. Once this scope ends,
 * no reader may use them; closing them does not release the physical update
 * lease or recovery artifacts when command cleanup is uncertain. */
export async function withPackageReverseSymlinkCustody<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const scope: Scope = { pins: new Map(), active: true };
  return custody.run(scope, async () => {
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await withCommandProcessScope(run, signal) };
    } catch (error) {
      outcome = { error };
    }
    scope.active = false;
    const errors: unknown[] = [];
    for (const pin of scope.pins.values()) {
      try {
        fs.closeSync(pin.fd);
      } catch (error) {
        errors.push(error);
      }
    }
    scope.pins.clear();
    if (errors.length) {
      throw new AggregateError(
        "error" in outcome ? [outcome.error, ...errors] : errors,
        "Reverse symlink descriptor cleanup failed.",
        "error" in outcome ? { cause: outcome.error } : undefined,
      );
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  });
}

export function readPackageReverseSymlink(file: string, initial: fs.BigIntStats): string {
  if (process.platform !== "darwin" || !fs.constants.O_SYMLINK) {
    // Unix npm launchers are normally symlinks. Their named inode is observed
    // without yielding; the effect path rechecks the same identity immediately
    // before rename. Darwin additionally retains the inode across awaited work.
    return observeNamedSymlink(initial, file);
  }
  const scope = custody.getStore();
  if (scope && !scope.active) {
    throw new Error("Reverse symlink custody has ended.");
  }
  const retained = scope?.pins.get(identity(initial));
  if (retained) {
    if (!same(initial, retained.stat) || observe(retained, file) !== retained.target) {
      throw new Error("Original reverse symlink image changed.");
    }
    return retained.target;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_SYMLINK);
  let keep = false;
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 4096n || !same(initial, stat)) {
      throw new Error("Reverse symlink descriptor does not match its captured inode.");
    }
    const pin: Pin = { fd, stat, target: "" };
    pin.target = observe(pin, file);
    if (scope) {
      scope.pins.set(identity(stat), pin);
      keep = true;
    }
    return pin.target;
  } finally {
    if (!keep) {
      fs.closeSync(fd);
    }
  }
}

/** Only the original publication's rename may advance a held inode's ctime.
 * All other generation/metadata fields and the inode-addressed target stay bound.
 * Reconcile a lost acknowledgement too; never repin from the destination path. */
export async function renamePackageReverseResource(
  from: string,
  to: string,
  options: { sourceIdentity: string; assertBeforeRename: () => void },
): Promise<void> {
  options.assertBeforeRename();
  const stat = fs.lstatSync(from, { bigint: true });
  if (identity(stat) !== options.sourceIdentity || fs.lstatSync(to, { throwIfNoEntry: false })) {
    throw new Error("Reverse rename source or destination preimage changed.");
  }
  const scope = custody.getStore();
  if (scope && !scope.active) {
    throw new Error("Reverse symlink custody has ended.");
  }
  const pin = scope?.pins.get(identity(stat));
  if (pin) {
    readPackageReverseSymlink(from, stat);
  }
  let failure: { error: unknown } | undefined;
  try {
    // No event-loop yield between the final retained-authority/slot checks and
    // this effect. External filesystem writers are still governed by maintenance.
    fs.renameSync(from, to);
  } catch (error) {
    failure = { error };
  }
  try {
    if (scope && !scope.active) {
      throw new Error("Reverse symlink custody ended during publication.");
    }
    if (pin) {
      const named = fs.lstatSync(to, { bigint: true, throwIfNoEntry: false });
      if (named && identity(named) === identity(pin.stat)) {
        const after = fs.fstatSync(pin.fd, { bigint: true });
        if (!same({ ...pin.stat, ctimeNs: after.ctimeNs }, after) || !same(after, named)) {
          throw new Error("Reverse symlink changed during publication.");
        }
        const prior = pin.stat;
        pin.stat = after;
        try {
          if (observe(pin, to) !== pin.target) {
            throw new Error("Reverse symlink target changed during publication.");
          }
        } catch (error) {
          pin.stat = prior;
          throw error;
        }
      }
    }
  } catch (error) {
    throw failure
      ? new AggregateError(
          [failure.error, error],
          "Reverse rename and symlink observation failed.",
          { cause: failure.error },
        )
      : error;
  }
  if (failure) {
    throw failure.error;
  }
}
