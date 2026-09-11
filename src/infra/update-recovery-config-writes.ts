import fs from "node:fs/promises";
import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { withConfigMutationLock } from "../config/mutate.js";
import { resolveConfigPath } from "../config/paths.js";
import {
  getConfigFileWriteCapture,
  recordConfigFileWrite,
  withConfigFileWriteCapture,
  type ConfigFileWrite,
} from "../config/write-capture.js";
import {
  mergeUpdateRecoveryConfigWrites,
  type UpdateRecoveryConfigWrite,
  type UpdateRecoveryBackupRef,
} from "./update-recovery-backup-contract.js";
import { canonicalEntryPath, digest, statOrMissing } from "./update-recovery-backup-files.js";

type Authority = { assertOwned: () => void };
const captureOwners = new WeakMap<Map<string, ConfigFileWrite>, string>();

function bindCapture(ref: UpdateRecoveryBackupRef): Map<string, ConfigFileWrite> | undefined {
  const capture = getConfigFileWriteCapture();
  if (!capture) {
    return undefined;
  }
  const key = `${ref.directory}\0${ref.manifestSha256}`;
  const previous = captureOwners.get(capture);
  if (previous !== undefined && previous !== key) {
    throw new Error("Config write capture belongs to another update recovery set.");
  }
  captureOwners.set(capture, key);
  return capture;
}

function capturedWrites(ref: UpdateRecoveryBackupRef): UpdateRecoveryConfigWrite[] {
  const capture = bindCapture(ref);
  if (!capture?.size) {
    return [];
  }
  return [...capture.values()].map((entry) => ({
    path: canonicalEntryPath(entry.path),
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash,
    contiguous: entry.contiguous,
  }));
}

/** Flush before a child can write the same config; successful publication starts a fresh suffix. */
export async function persistUpdateRecoveryConfigWrites(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<void> {
  const capture = getConfigFileWriteCapture();
  const writes = capturedWrites(ref);
  if (!capture || writes.length === 0) {
    return;
  }
  const snapshot = new Map(capture);
  const { appendUpdateRecoveryConfigWrites } = await import("./update-recovery-backup.js");
  await appendUpdateRecoveryConfigWrites(ref, writes, authority);
  if (
    capture.size !== snapshot.size ||
    [...snapshot].some(([key, entry]) => capture.get(key) !== entry)
  ) {
    throw new Error(
      `Config writers changed during receipt publication; their capture was retained. Backup retained at ${ref.manifestPath}; run npx openclaw@latest doctor --fix after resolving ownership.`,
    );
  }
  capture.clear();
}

export async function withUpdateRecoveryConfigWrites<T>(
  ref: UpdateRecoveryBackupRef | undefined | (() => UpdateRecoveryBackupRef | undefined),
  authority: Authority,
  run: () => Promise<T>,
): Promise<T> {
  if (!ref) {
    return await run();
  }
  const current = typeof ref === "function" ? ref : () => ref;
  return await withConfigFileWriteCapture(async () => {
    const initial = current();
    if (initial) {
      bindCapture(initial);
    }
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await run() };
    } catch (error) {
      result = { ok: false, error };
    }
    const backup = current();
    try {
      if (backup) {
        await persistUpdateRecoveryConfigWrites(backup, authority);
      }
    } catch (error) {
      if (!result.ok) {
        throw new AggregateError(
          [result.error, error],
          `Update failed and config write receipts could not be recorded. Backup retained at ${backup?.manifestPath}; run npx openclaw@latest doctor --fix after resolving ownership.`,
          { cause: error },
        );
      }
      throw error;
    }
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  });
}

async function currentHash(pathname: string): Promise<string | null> {
  const entry = await statOrMissing(pathname);
  return entry ? digest(await fs.readFile(pathname)) : null;
}

function originalHash(manifest: UpdateRecoveryBackupManifest, pathname: string): string | null {
  const entry = manifest.entries.find((candidate) => candidate.sourcePath === pathname);
  if (entry?.kind === "file") {
    return entry.sha256;
  }
  if (entry?.kind === "missing") {
    return null;
  }
  if (entry?.kind === "symlink" && entry.contentPath) {
    const target = manifest.entries.find((candidate) => candidate.sourcePath === entry.contentPath);
    if (target?.kind === "file") {
      return target.sha256;
    }
  }
  throw new Error(`Update recovery config has no captured bytes: ${pathname}`);
}

async function assertPaths(
  ref: UpdateRecoveryBackupRef,
  manifest: UpdateRecoveryBackupManifest,
  saved: readonly UpdateRecoveryConfigWrite[],
  authority: Authority,
): Promise<void> {
  const writes = new Map(
    mergeUpdateRecoveryConfigWrites(saved, capturedWrites(ref)).map((entry) => [entry.path, entry]),
  );
  const unexpected = [...writes.keys()].find(
    (pathname) => !manifest.configPaths.includes(pathname),
  );
  if (unexpected) {
    throw new Error(
      `Config write ${unexpected} is outside the update backup inventory. Backup retained at ${ref.manifestPath}; run npx openclaw@latest doctor --fix after resolving ownership.`,
    );
  }
  const rejectChangedConfig = (pathname: string): never => {
    throw new Error(
      `Configuration ${pathname} changed outside the recorded update writes; recovery was refused to preserve those bytes. Backup retained at ${ref.manifestPath}; after resolving the edit, run npx openclaw@latest doctor --fix.`,
    );
  };
  for (const pathname of manifest.configPaths) {
    let ownerPath = pathname;
    const original = manifest.entries.find((entry) => entry.sourcePath === pathname);
    const actual = await statOrMissing(pathname);
    let replacedLink = false;
    if (original?.kind === "symlink" && original.contentPath) {
      if (actual?.isSymbolicLink()) {
        if (
          (await fs.readlink(pathname)) !== original.target ||
          (await fs.realpath(pathname)) !== original.contentPath
        ) {
          rejectChangedConfig(pathname);
        }
        ownerPath = original.contentPath;
      } else {
        replacedLink = true;
      }
    } else if (actual?.isSymbolicLink()) {
      rejectChangedConfig(pathname);
    }
    const before = originalHash(manifest, ownerPath);
    const write = writes.get(ownerPath);
    const expected = write ? write.afterHash : before;
    const observed = await currentHash(pathname);
    authority.assertOwned();
    // Atomic config writes can replace a link; restore also records its temporary unlink.
    if (
      replacedLink &&
      (!write || !write.contiguous || write.beforeHash !== before || observed !== write.afterHash)
    ) {
      rejectChangedConfig(pathname);
    }
    if (observed === before) {
      continue;
    }
    if ((write && (!write.contiguous || write.beforeHash !== before)) || observed !== expected) {
      rejectChangedConfig(pathname);
    }
  }
}

async function withConfigLocks<T>(
  manifest: UpdateRecoveryBackupManifest,
  authority: Authority,
  run: () => Promise<T>,
): Promise<T> {
  const selectedRoot = resolveConfigPath();
  const canonicalRoot = canonicalEntryPath(selectedRoot);
  const paths = [
    selectedRoot,
    ...manifest.configPaths.filter((pathname) => pathname !== canonicalRoot).toSorted(),
  ];
  const lock = async (index: number): Promise<T> => {
    const pathname = paths[index];
    if (pathname === undefined) {
      authority.assertOwned();
      return await run();
    }
    return await withConfigMutationLock({ lockPath: pathname }, () => lock(index + 1));
  };
  return await lock(0);
}

/** Retain all config locks from byte admission through the complete restore. */
export async function withUpdateRecoveryConfigValidation<T>(
  ref: UpdateRecoveryBackupRef,
  manifest: UpdateRecoveryBackupManifest,
  authority: Authority,
  run: (assertConfigCurrent: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return await withConfigLocks(manifest, authority, async () => {
    const { readUpdateRecoveryConfigState } = await import("./update-recovery-backup.js");
    const state = await readUpdateRecoveryConfigState(ref, authority);
    const assertConfigCurrent = () =>
      assertPaths(ref, state.manifest, state.configWrites, authority);
    await assertConfigCurrent();
    return await run(assertConfigCurrent);
  });
}

export async function assertUpdateRecoveryConfigUnchanged(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<void> {
  const { readUpdateRecoveryConfigState } = await import("./update-recovery-backup.js");
  const state = await readUpdateRecoveryConfigState(ref, authority);
  await withUpdateRecoveryConfigValidation(ref, state.manifest, authority, async () => {});
}

/** A restore is an owned write too; later checks must distinguish it from an operator edit. */
export async function captureUpdateRecoveryConfigRestore<T>(
  manifest: UpdateRecoveryBackupManifest,
  pathname: string,
  run: () => Promise<T>,
  published: "original" | "absent" = "original",
): Promise<T> {
  if (!manifest.configPaths.includes(pathname)) {
    return await run();
  }
  const before = await currentHash(pathname);
  const result = await run();
  const after = published === "absent" ? null : originalHash(manifest, pathname);
  if (before !== after) {
    recordConfigFileWrite(pathname, before, after);
  }
  return result;
}
