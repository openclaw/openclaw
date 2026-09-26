import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLargeDirectoryId } from "../../test/helpers/fs-large-directory-id.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import {
  createGenericDatabase,
  createGenericSnapshot,
  readGenericValues,
  useLocalRepositoryFixtures,
  withRestoredSpies,
} from "./local-repository.test-support.js";
import { SNAPSHOT_SQLITE_FILENAME } from "./snapshot-provider.js";

const { createTempDir, createGenericRepositoryFixture } = useLocalRepositoryFixtures(afterEach);

describe("local SQLite snapshot directory identities", () => {
  it.each(["repository", "validation", "restore"] as const)(
    "retains an exact large directory ID through %s operations",
    async (operation) => {
      const fixture = await createGenericRepositoryFixture({ useValidationRoot: true });
      const { provider, repositoryPath, validationRootPath, restorePath, sourcePath } = fixture;
      if (operation === "repository") {
        await fs.mkdir(repositoryPath, { mode: 0o700 });
      } else if (operation === "restore") {
        await fs.mkdir(path.dirname(restorePath), { mode: 0o700 });
      }
      const snapshot =
        operation === "repository"
          ? undefined
          : await createGenericSnapshot(provider, sourcePath, "large-directory-id");
      const directoryPath =
        operation === "repository"
          ? repositoryPath
          : operation === "validation"
            ? validationRootPath
            : path.dirname(restorePath);
      const identitySpy = mockLargeDirectoryId(directoryPath);
      await withRestoredSpies([identitySpy], async () => {
        const created =
          snapshot ?? (await createGenericSnapshot(provider, sourcePath, "large-directory-id"));
        if (operation === "restore") {
          await expect(provider.restoreFresh(created.ref, restorePath)).resolves.toEqual({
            ok: true,
            manifest: created.manifest,
          });
          expect(readGenericValues(restorePath)).toEqual([{ value: "one" }]);
          await expect(fs.readdir(directoryPath)).resolves.toEqual(["source.sqlite"]);
        } else {
          await expect(provider.verify(created.ref)).resolves.toEqual({
            ok: true,
            manifest: created.manifest,
          });
          expect(readGenericValues(path.join(created.ref.path, SNAPSHOT_SQLITE_FILENAME))).toEqual([
            { value: "one" },
          ]);
          if (operation === "validation") {
            await expect(fs.readdir(validationRootPath)).resolves.toEqual([]);
          }
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts protected symlinked ancestors through their canonical path",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const realSharedPath = path.join(tempDir, "real-shared");
      const aliasSharedPath = path.join(tempDir, "alias-shared");
      const validationRootPath = path.join(aliasSharedPath, "validation");
      const restorePath = path.join(aliasSharedPath, "restore", "source.sqlite");
      createGenericDatabase(sourcePath, { values: ["canonical-staging"] });
      await fs.mkdir(path.join(realSharedPath, "validation"), { recursive: true, mode: 0o700 });
      await fs.chmod(path.join(realSharedPath, "validation"), 0o700);
      await fs.symlink(realSharedPath, aliasSharedPath, "dir");
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        validationRootPath,
      });
      const snapshot = await createGenericSnapshot(provider, sourcePath, "canonical-staging");

      await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).resolves.toMatchObject({
        ok: true,
      });
      expect(readGenericValues(restorePath)).toEqual([{ value: "canonical-staging" }]);

      const otherSharedPath = path.join(tempDir, "other-shared");
      await fs.mkdir(path.join(otherSharedPath, "validation"), { recursive: true, mode: 0o700 });
      const canonicalValidationRoot = await fs.realpath(validationRootPath);
      const originalMkdtemp = fs.mkdtemp.bind(fs);
      let redirected = false;
      const mkdtempSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
        const directoryPath = await originalMkdtemp(prefix, options);
        if (!redirected && path.dirname(prefix) === canonicalValidationRoot) {
          redirected = true;
          await fs.unlink(aliasSharedPath);
          await fs.symlink(otherSharedPath, aliasSharedPath, "dir");
        }
        return directoryPath;
      });
      await withRestoredSpies([mkdtempSpy], async () => {
        await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
      });
      expect(redirected).toBe(true);
      await expect(fs.readdir(canonicalValidationRoot)).resolves.toEqual([]);
      await expect(fs.readdir(validationRootPath)).resolves.toEqual([]);
    },
  );
});
