import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { root as openRoot } from "@openclaw/fs-safe/root";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import { packageActivationIdentityOrAbsent as entryIdentity } from "./package-update-activation-custody.js";
import type { PackageActivationDescriptor } from "./package-update-activation-journal.js";
import { LEGACY_PACKAGE_RECOVERY_HELPER } from "./package-update-activation-paths.js";
import {
  assertPackagePathIdentity,
  createPackagePathAssertion,
} from "./package-update-filesystem.js";
import {
  createPackageIntegrityReader,
  isPackageIntegrityResourceError,
  packageIntegrityDifferences,
  type PackageIntegrityFingerprint,
  PackageIntegrityMismatchError,
} from "./package-update-integrity.js";

/** Fill an already journal-owned directory without changing the live tree. */
export async function copyPackagePublicationTree(
  source: string,
  destination: string,
  assertion: () => void,
): Promise<void> {
  const assertCurrent = retainMutationAuthority(assertion);
  assertCurrent();
  const root = await openRoot(destination, { assertBeforeMutation: assertCurrent });
  assertCurrent();
  const copy = async (relative: string, assertParents: () => void): Promise<void> => {
    assertParents();
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    const original = fs.lstatSync(from, { bigint: true });
    const assertSource = createPackagePathAssertion(from, original, assertParents);
    if (original.isDirectory()) {
      if (relative) {
        await root.mkdir(relative, { private: true, assertBeforeMutation: assertSource });
      }
      assertSource();
      const directory = fs.lstatSync(to, { bigint: true });
      const assertDirectory = createPackagePathAssertion(to, directory, assertSource);
      const children = await fsp.readdir(from);
      assertDirectory();
      for (const child of children) {
        await copy(path.join(relative, child), assertDirectory);
      }
      assertDirectory();
      if (directory.uid !== original.uid || directory.gid !== original.gid) {
        await fsp.chown(to, Number(original.uid), Number(original.gid));
        assertDirectory();
      }
      await fsp.chmod(to, Number(original.mode));
      assertDirectory();
      requireDirectorySync(await syncDirectory(to), "Copied package directory");
      assertDirectory();
    } else if (original.isFile()) {
      await root.copyIn(relative, from, {
        sourceHardlinks: "allow",
        preserveSourceMode: true,
        maxBytes: Number(original.size),
        mkdir: false,
        overwrite: false,
        durable: false,
        assertBeforeMutation: assertSource,
      });
      assertSource();
      const copied = fs.lstatSync(to, { bigint: true });
      const opened = await root.open(relative);
      try {
        assertSource();
        assertPackagePathIdentity(to, copied);
        const actual = fs.fstatSync(opened.handle.fd, { bigint: true });
        if (actual.dev !== copied.dev || actual.ino !== copied.ino) {
          throw new Error("Copied package file changed before persistence.");
        }
        if (actual.uid !== original.uid || actual.gid !== original.gid) {
          await opened.handle.chown(Number(original.uid), Number(original.gid));
          assertSource();
        }
        await opened.handle.chmod(Number(original.mode));
        assertSource();
        await opened.handle.sync();
        assertSource();
        assertPackagePathIdentity(to, copied);
      } finally {
        await opened.handle.close();
      }
    } else if (original.isSymbolicLink()) {
      const target = await fsp.readlink(from);
      assertSource();
      await fsp.symlink(target, to);
      assertSource();
      const copied = fs.lstatSync(to, { bigint: true });
      if (copied.uid !== original.uid || copied.gid !== original.gid) {
        await fsp.lchown(to, Number(original.uid), Number(original.gid));
        assertSource();
      }
      assertPackagePathIdentity(to, copied);
      if (process.platform === "darwin" && copied.mode !== original.mode) {
        await fsp.lchmod(to, Number(original.mode));
        assertSource();
      }
    } else {
      throw new Error(`Unsupported package copy entry: ${from}`);
    }
    assertSource();
  };
  await copy("", assertCurrent);
}

export function createPackagePublicationTreeMatcher(
  descriptor: Pick<PackageActivationDescriptor, "candidate" | "previous" | "helperDigest">,
  onWarning: (message: string) => void,
) {
  let candidateWarningRecorded = false;
  const verified = new WeakMap<PackageIntegrityFingerprint, PackageIntegrityFingerprint>();
  let legacyWarning: string | undefined;
  const legacy = descriptor.helperDigest === LEGACY_PACKAGE_RECOVERY_HELPER;
  const matches = async (
    file: string,
    expected: PackageActivationDescriptor["candidate"],
    logical: string,
    contents = true,
  ) => {
    const id = entryIdentity(file, true);
    if (id === null) {
      return false;
    }
    if (id !== expected.identity) {
      throw new Error(`Package publication object changed: ${file}`);
    }
    if (!contents) {
      return true;
    }
    // Legacy package code is reinstallable; accept its previous identity/version without the stale seal.
    const legacyPrevious = legacy && expected === descriptor.previous;
    // A prepared descriptor carries its in-process observation, so settled unchanged
    // files are not re-read. A recovery process parses one without and re-reads all.
    if ("digest" in expected && !legacyPrevious) {
      try {
        const observed = await createPackageIntegrityReader().tree(
          file,
          logical,
          verified.get(expected) ?? expected,
          legacy,
        );
        if (!isDeepStrictEqual(observed, expected)) {
          throw new PackageIntegrityMismatchError(
            `Package publication object changed: ${file}`,
            packageIntegrityDifferences(expected, observed),
          );
        }
        // A fresh preparation read may predate digest reuse eligibility. Keep
        // later settled observations, but always compare with the original bytes.
        verified.set(expected, observed);
        return true;
      } catch (error) {
        if (expected !== descriptor.candidate || !isPackageIntegrityResourceError(error)) {
          throw error;
        }
      }
    }
    const observed = await createPackageIntegrityReader().directoryIdentity(file);
    if (observed?.identity !== expected.identity || observed.version !== expected.version) {
      throw new Error(`Package publication object changed: ${file}`);
    }
    if (legacyPrevious) {
      if (!legacyWarning) {
        legacyWarning =
          "legacy package record settled by identity and version; content could not be re-verified";
        onWarning(legacyWarning);
      }
      return true;
    }
    if (!candidateWarningRecorded) {
      onWarning(
        "candidate package fingerprint incomplete; activation requires the directory identity, package version and launchers; full package contents are unverified",
      );
      candidateWarningRecorded = true;
    }
    return true;
  };
  return {
    matches,
    get legacyWarning() {
      return legacyWarning;
    },
  };
}
