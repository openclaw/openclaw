import fs from "node:fs";
import path from "node:path";
import { removePathWithinRoot } from "./fs-safe-remove.js";
import { retainMutationAuthority } from "./mutation-authority.js";

/** Keep recovery scratch attached to its original journal/control authority.
 * The callback must recheck the supplied guard after awaited transport, before
 * opening the result. Cleanup never adopts a successor directory or parent. */
export async function withPackageRecoverySnapshot<T>(
  control: string,
  assertCurrent: () => void,
  read: (targetPath: string, assertSnapshot: () => void) => Promise<T>,
): Promise<T> {
  const assertOwner = retainMutationAuthority(assertCurrent);
  assertOwner();
  const directory = fs.mkdtempSync(path.join(control, ".recovery-snapshot-"));
  const original = fs.lstatSync(directory, { bigint: true });
  const assertSnapshot = (allowMissing = false) => {
    assertOwner();
    const current = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (
      (!current && !allowMissing) ||
      (current &&
        (!current.isDirectory() ||
          current.isSymbolicLink() ||
          (current.mode & 0o077n) !== 0n ||
          current.dev !== original.dev ||
          current.ino !== original.ino))
    ) {
      throw new Error("Package recovery snapshot directory changed.");
    }
  };
  let outcome: { value: T } | { error: unknown };
  try {
    assertSnapshot();
    const value = await read(path.join(directory, "operation.sqlite"), assertSnapshot);
    assertSnapshot();
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  let cleanupFailure: { error: unknown } | undefined;
  try {
    await removePathWithinRoot({
      rootDir: control,
      relativePath: path.basename(directory),
      recursive: true,
      force: true,
      assertBeforeMutation: () => assertSnapshot(true),
    });
  } catch (error) {
    cleanupFailure = { error };
  }
  if (cleanupFailure) {
    if ("error" in outcome) {
      throw new AggregateError(
        [outcome.error, cleanupFailure.error],
        "Recovery snapshot and owned cleanup failed.",
        { cause: outcome.error },
      );
    }
    throw cleanupFailure.error;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
