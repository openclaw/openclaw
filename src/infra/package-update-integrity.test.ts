import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { interceptPackageFileHashes } from "./package-update-integrity-hasher.test-support.js";
import {
  PackageIntegrityLimitError,
  PackageIntegrityTimeoutError,
  createPackageIntegrityReader,
  isPackageIntegrityResourceError,
  sweepForDrift,
} from "./package-update-integrity.js";

// A large global install (a real 2026.10.1 install is 612 MB across ~41,900
// files) makes the swap's rollback-verification scan expensive: the final drift
// sweep alone re-stats every entry. Doing that strictly one entry at a time is
// tens of thousands of sequential syscalls, which stretches the walk past its
// deadline and widens the window a concurrent writer has to change a timestamp —
// and an aborted verification fails an otherwise healthy update.

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await cleanup();
  }),
);

/** A package-shaped tree: manifest, files, a symlink and a hardlink. */
async function createPackageFixture(entries = 4): Promise<string> {
  const root = tempDirs.make("package-integrity-");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await Promise.all(
    Array.from({ length: entries }, (_unused, index) =>
      fs.writeFile(
        path.join(root, "dist", `file-${index}.js`),
        `export const v${index} = ${index};\n`,
      ),
    ),
  );
  await fs.symlink("file-0.js", path.join(root, "dist", "link.js"));
  await fs.link(path.join(root, "dist", "file-0.js"), path.join(root, "dist", "hardlink.js"));
  return root;
}

/** Stat entries the way the walk records them, without touching the reader. */
async function observe(root: string) {
  const observed: Array<{ file: string; stat: Awaited<ReturnType<typeof fs.lstat>> }> = [];
  const walk = async (directory: string) => {
    for (const child of await fs.readdir(directory)) {
      const file = path.join(directory, child);
      // The reader records bigint stats; match that so `packageStatUnchanged`
      // compares like for like.
      const stat = await fs.lstat(file, { bigint: true });
      observed.push({ file, stat });
      if (stat.isDirectory()) {
        await walk(file);
      }
    }
  };
  await walk(root);
  return observed;
}

afterEach(() => vi.restoreAllMocks());

describe("sweepForDrift", () => {
  it("accepts a tree whose entries all still match", async () => {
    const root = await createPackageFixture();
    const observed = await observe(root);
    await expect(sweepForDrift(observed, (operation) => operation())).resolves.toBeUndefined();
  });

  it("refuses a changed entry", async () => {
    const root = await createPackageFixture();
    const observed = await observe(root);
    await fs.writeFile(path.join(root, "dist", "file-0.js"), "mutated\n");
    await expect(sweepForDrift(observed, (operation) => operation())).rejects.toThrow(
      /Package rollback tree changed during verification/,
    );
  });

  it("refuses an entry that vanished", async () => {
    const root = await createPackageFixture();
    const observed = await observe(root);
    await fs.rm(path.join(root, "dist", "file-0.js"));
    await expect(sweepForDrift(observed, (operation) => operation())).rejects.toThrow(
      /Package rollback tree changed during verification/,
    );
  });

  it("rethrows a resource failure instead of reporting drift", async () => {
    // Callers only take their directory-identity fallback for
    // `isPackageIntegrityResourceError`. Swallowing a budget or limit error into
    // a generic drift refusal would abort an update that could have degraded to
    // an incomplete-fingerprint warning instead.
    const root = await createPackageFixture();
    const observed = await observe(root);
    const timeout = new PackageIntegrityTimeoutError(30_000);
    await expect(
      sweepForDrift(observed, () => {
        throw timeout;
      }),
    ).rejects.toBe(timeout);

    const limit = new PackageIntegrityLimitError("entry");
    await expect(
      sweepForDrift(observed, () => {
        throw limit;
      }),
    ).rejects.toBe(limit);
  });

  it("prefers drift evidence over a resource failure in the same batch", async () => {
    // When a batch both proves drift and exhausts the budget, drift wins: the
    // tree really did change and the operator needs the specific refusal.
    const root = await createPackageFixture();
    const observed = await observe(root);
    let calls = 0;
    const read = <T>(operation: () => Promise<T>): Promise<T> => {
      calls += 1;
      if (calls === 1) {
        throw new PackageIntegrityTimeoutError(30_000);
      }
      return operation();
    };
    await fs.writeFile(path.join(root, "dist", "file-0.js"), "mutated\n");
    await expect(sweepForDrift(observed, read)).rejects.toThrow(
      /Package rollback tree changed during verification/,
    );
  });
});

describe("package integrity reader", () => {
  it("refuses a tree that changes after the walk observed it", async () => {
    // The drift sweep is the only thing standing between a concurrent writer and
    // an accepted rollback. Mutate from inside the hash step — after the walk has
    // already admitted that entry's stat — and the sweep must still refuse.
    const root = await createPackageFixture(8);
    let mutated = false;
    interceptPackageFileHashes(async (file, _stat, next) => {
      const digest = await next();
      if (!mutated && file.endsWith("file-0.js")) {
        mutated = true;
        await fs.writeFile(file, "mutated after admission\n");
      }
      return digest;
    });

    const reader = createPackageIntegrityReader(20 * 60_000);
    await expect(reader.rootEntry(root)).rejects.toThrow(
      /Package rollback tree changed during verification/,
    );
  });

  it("refuses a tree whose entry disappears after the walk observed it", async () => {
    const root = await createPackageFixture(8);
    let removed = false;
    interceptPackageFileHashes(async (file, _stat, next) => {
      const digest = await next();
      if (!removed && file.endsWith("file-1.js")) {
        removed = true;
        await fs.rm(file);
      }
      return digest;
    });

    const reader = createPackageIntegrityReader(20 * 60_000);
    await expect(reader.rootEntry(root)).rejects.toThrow(
      /Package rollback tree changed during verification/,
    );
  });

  it("reports the budget it was constructed with when the walk exceeds it", async () => {
    const root = await createPackageFixture();
    const reader = createPackageIntegrityReader(1);
    const error = await reader.rootEntry(root).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PackageIntegrityTimeoutError);
    expect(isPackageIntegrityResourceError(error)).toBe(true);
    expect((error as PackageIntegrityTimeoutError).budgetMs).toBe(1);
  });

  it("produces the same fingerprint across repeated walks of an unchanged tree", async () => {
    const root = await createPackageFixture();
    const first = createPackageIntegrityReader(20 * 60_000);
    const second = createPackageIntegrityReader(20 * 60_000);
    const a = await first.rootEntry(root);
    const b = await second.rootEntry(root);
    expect(a.kind).toBe("directory");
    expect(b.kind).toBe("directory");
    if (a.kind !== "directory" || b.kind !== "directory") {
      return;
    }
    expect(a.tree.digest).toBe(b.tree.digest);
    expect(a.tree.version).toBe("9.9.9");
  });

  it("accepts a tree whose contents changed before the walk observed them", async () => {
    // A write that lands before the walk stats the file is simply the new state:
    // the fingerprint describes it, and verification must succeed.
    const root = await createPackageFixture();
    await fs.writeFile(path.join(root, "dist", "file-0.js"), "rewritten before the walk\n");
    const reader = createPackageIntegrityReader(20 * 60_000);
    const entry = await reader.rootEntry(root);
    expect(entry.kind).toBe("directory");
  });
});
