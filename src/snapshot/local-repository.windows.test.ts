import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import {
  createPrivateSqliteDirectory,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "../infra/sqlite-private-directory.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import { createGenericSnapshot, withDatabase } from "./local-repository.test-support.js";
import { SNAPSHOT_SQLITE_FILENAME } from "./snapshot-provider.js";

const MAX_PATH = 260;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const privateTempRoot =
  process.platform === "win32" ? resolvePrivateSqliteSnapshotStagingRoot() : undefined;

async function fixture(sql = "") {
  const tempDir = tempDirs.make("openclaw-snapshot-windows-", privateTempRoot);
  const privateRootPath = path.join(tempDir, "private");
  await createPrivateSqliteDirectory(privateRootPath);
  const sourcePath = path.join(privateRootPath, "source.sqlite");
  withDatabase(sourcePath, (source) => source.exec(sql));
  const repositoryPath = path.join(privateRootPath, "snapshots");
  const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
  const create = (id: string) => createGenericSnapshot(provider, sourcePath, id);
  return { tempDir, privateRootPath, repositoryPath, provider, create };
}
const stagingPath = (root: string, prefix: string) =>
  path.join(root, `${prefix}${"0".repeat(36)}`, SNAPSHOT_SQLITE_FILENAME);

describe.runIf(process.platform === "win32")("local SQLite snapshot repository on Windows", () => {
  it("uses Desktop ACL modules when an inherited Core-only module shadows them", async () => {
    const { tempDir, provider, create } = await fixture();
    const moduleRoot = path.join(tempDir, "modules");
    const shadowModule = path.join(moduleRoot, "Microsoft.PowerShell.Security", "99.0.0");
    await fs.mkdir(shadowModule, { recursive: true });
    await fs.writeFile(
      path.join(shadowModule, "Microsoft.PowerShell.Security.psd1"),
      "@{ ModuleVersion = '99.0.0'; PowerShellVersion = '7.0'; CompatiblePSEditions = @('Core'); RootModule = 'Microsoft.PowerShell.Security.psm1'; FunctionsToExport = @('Get-Acl') }",
    );
    await fs.writeFile(
      path.join(shadowModule, "Microsoft.PowerShell.Security.psm1"),
      "function Get-Acl { throw 'Core-only test module must not be loaded' }; Export-ModuleMember -Function Get-Acl",
    );
    // Windows worker env objects are case-sensitive; uppercase wins child-process duplicates.
    const PSMODULEPATH = [moduleRoot, resolveEnvironmentValue(process.env, "PSModulePath")]
      .filter(Boolean)
      .join(path.delimiter);
    await withEnvAsync({ PSMODULEPATH }, async () => {
      const snapshot = await create("windows-shadowed-security-module");
      await expect(provider.verify(snapshot.ref)).resolves.toEqual({
        ok: true,
        manifest: snapshot.manifest,
      });
    });
  });

  it("verifies and cleans staging when the SQLite path exceeds MAX_PATH", async () => {
    const { privateRootPath, repositoryPath, create } = await fixture(
      "CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');",
    );

    const shortStagingPath = stagingPath(repositoryPath, ".tmp-");
    expect(shortStagingPath.length).toBeLessThan(MAX_PATH);
    const snapshot = await create("windows-long-verification-path");

    let validationRootPath = path.join(privateRootPath, "validation");
    let stagedSqlitePath = stagingPath(validationRootPath, ".tmp-verify-");
    while (stagedSqlitePath.length <= MAX_PATH) {
      validationRootPath = path.join(validationRootPath, `segment-${"x".repeat(24)}`);
      stagedSqlitePath = stagingPath(validationRootPath, ".tmp-verify-");
    }
    expect(validationRootPath.length).toBeLessThan(MAX_PATH);
    expect(stagedSqlitePath.length).toBeGreaterThan(MAX_PATH);
    await fs.mkdir(validationRootPath, { recursive: true });
    expect((await fs.lstat(validationRootPath)).isDirectory()).toBe(true);

    const verifier = createLocalSqliteSnapshotProvider({
      repositoryPath,
      validationRootPath,
    });
    await expect(verifier.verify(snapshot.ref)).resolves.toEqual({
      ok: true,
      manifest: snapshot.manifest,
    });
    await expect(fs.readdir(validationRootPath)).resolves.toEqual([]);
  });
});
