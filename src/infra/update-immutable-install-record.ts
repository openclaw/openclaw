import fs from "node:fs/promises";
import { hasErrnoCode } from "./errno.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import { runSqliteReadOnlyOperation } from "./sqlite-readonly-worker.js";
import { readDatabasePathIdentity } from "./sqlite-worker-identity.js";
import { ImmutableInstallRecordSchema } from "./update-immutable-install-schema.js";

export async function readImmutableInstallRecord(root: string) {
  const anchor = resolvePackageActivationAnchor(root);
  try {
    await fs.lstat(resolvePackageActivationControl(anchor));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const journal = resolvePackageActivationJournalPath(anchor);
  const identity = await readDatabasePathIdentity(journal);
  const record = await runSqliteReadOnlyOperation(
    journal,
    { type: "immutableInstall.read", input: { root } },
    { source: "canonical", expectedIdentity: identity.key, env: process.env },
  );
  return ImmutableInstallRecordSchema.parse(record);
}
