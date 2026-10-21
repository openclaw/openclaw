import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mockLargeDirectoryId } from "../../test/helpers/fs-large-directory-id.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import {
  createGenericSnapshot,
  readGenericValues,
  useLocalRepositoryFixtures,
} from "./local-repository.test-support.js";
import { SNAPSHOT_SQLITE_FILENAME } from "./snapshot-provider.js";

const { createGenericRepositoryFixture } = useLocalRepositoryFixtures(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["repository", "validation", "restore"] as const)(
  "retains an exact large directory ID through %s operations",
  async (operation) => {
    const { provider, repositoryPath, validationRootPath, restorePath, sourcePath } =
      await createGenericRepositoryFixture({ useValidationRoot: true });
    if (operation === "repository") {
      await fs.mkdir(repositoryPath, { mode: 0o700 });
    } else if (operation === "restore") {
      await fs.mkdir(path.dirname(restorePath), { mode: 0o700 });
    }
    const create = () => createGenericSnapshot(provider, sourcePath, "large-directory-id");
    const snapshot = operation === "repository" ? undefined : await create();
    const directoryPath = {
      repository: repositoryPath,
      validation: validationRootPath,
      restore: path.dirname(restorePath),
    }[operation];
    mockLargeDirectoryId(directoryPath);
    const created = snapshot ?? (await create());
    await expect(
      operation === "restore"
        ? provider.restoreFresh(created.ref, restorePath)
        : provider.verify(created.ref),
    ).resolves.toEqual({ ok: true, manifest: created.manifest });
    const databasePath =
      operation === "restore" ? restorePath : path.join(created.ref.path, SNAPSHOT_SQLITE_FILENAME);
    expect(readGenericValues(databasePath)).toEqual([{ value: "one" }]);
    if (operation !== "repository") {
      expect(await fs.readdir(directoryPath)).toEqual(
        operation === "restore" ? ["source.sqlite"] : [],
      );
    }
  },
);

it.runIf(process.platform !== "win32")(
  "accepts protected symlinked ancestors through their canonical path",
  async () => {
    const { tempDir, sourcePath, repositoryPath } = await createGenericRepositoryFixture();
    const realShared = path.join(tempDir, "real-shared");
    const aliasShared = path.join(tempDir, "alias-shared");
    const validationRootPath = path.join(aliasShared, "validation");
    const restorePath = path.join(aliasShared, "restore", "source.sqlite");
    await fs.mkdir(path.join(realShared, "validation"), { recursive: true, mode: 0o700 });
    await fs.chmod(path.join(realShared, "validation"), 0o700);
    await fs.symlink(realShared, aliasShared, "dir");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath, validationRootPath });
    const snapshot = await createGenericSnapshot(provider, sourcePath, "canonical-staging");

    expect(await provider.verify(snapshot.ref)).toMatchObject({ ok: true });
    expect(await provider.restoreFresh(snapshot.ref, restorePath)).toMatchObject({ ok: true });
    expect(readGenericValues(restorePath)).toEqual([{ value: "one" }]);

    const otherShared = path.join(tempDir, "other-shared");
    await fs.mkdir(path.join(otherShared, "validation"), { recursive: true, mode: 0o700 });
    const canonicalValidationRoot = await fs.realpath(validationRootPath);
    const originalMkdtemp = fs.mkdtemp.bind(fs);
    let redirected = false;
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
      const directoryPath = await originalMkdtemp(prefix, options);
      if (!redirected && path.dirname(prefix) === canonicalValidationRoot) {
        redirected = true;
        await fs.unlink(aliasShared);
        await fs.symlink(otherShared, aliasShared, "dir");
      }
      return directoryPath;
    });
    expect(await provider.verify(snapshot.ref)).toMatchObject({ ok: true });
    expect(redirected).toBe(true);
    expect(await fs.readdir(canonicalValidationRoot)).toEqual([]);
    expect(await fs.readdir(validationRootPath)).toEqual([]);
  },
);
