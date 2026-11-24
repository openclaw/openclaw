import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { backupCase, declarePluginSqliteResources } from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";

const walkState = vi.hoisted(() => ({ filterImage: false, failAfterImage: false, attempts: 0 }));
vi.mock("./backup-tar-walk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-tar-walk.js")>();
  return {
    ...actual,
    async *walkBackupTar(params: Parameters<typeof actual.walkBackupTar>[0]) {
      walkState.attempts += 1;
      let verifiedImage: string | undefined;
      yield* actual.walkBackupTar({
        ...params,
        filter: (source, stat) =>
          !(walkState.filterImage && params.contentChecks?.has(path.resolve(source))) &&
          params.filter(source, stat),
        onContentVerified: (source) => {
          verifiedImage = source;
          params.onContentVerified?.(source);
        },
      });
      if (walkState.failAfterImage && walkState.attempts === 1 && verifiedImage) {
        await flipLastByte(verifiedImage);
        walkState.filterImage = true;
        throw Object.assign(new Error("interrupted first archive"), { code: "EOF" });
      }
    },
  };
});
vi.mock("../utils/sleep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/sleep.js")>()),
  sleep: async () => {},
}));
afterEach(() => {
  Object.assign(walkState, { filterImage: false, failAfterImage: false, attempts: 0 });
  vi.restoreAllMocks();
});

async function flipLastByte(file: string) {
  await using handle = await fs.open(file, "r+");
  const { size } = await handle.stat();
  const byte = Buffer.alloc(1);
  await handle.read(byte, 0, 1, size - 1);
  byte.writeUInt8(byte.readUInt8(0) ^ 0xff, 0);
  await handle.write(byte, 0, 1, size - 1);
}
function changeImageAfterCapture(databaseName: string) {
  const capture = sqliteSnapshot.createVerifiedSqliteSnapshot;
  const changed = vi.fn(flipLastByte);
  vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot").mockImplementation(async (options) => {
    const result = await capture(options);
    if (!changed.mock.calls.length && path.basename(options.sourcePath) === databaseName) {
      await changed(options.targetPath);
    }
    return result;
  });
  return changed;
}
const pluginCase = backupCase({ prefix: "backup-sqlite-content-check-" });
async function setup(state: Parameters<Parameters<typeof pluginCase>[0]>[0], alias = false) {
  await declarePluginSqliteResources(state);
  const databasePath = state.statePath("plugins", "dedicated", "alpha.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  {
    using db = new (requireNodeSqlite().DatabaseSync)(databasePath);
    db.exec("CREATE TABLE records (payload BLOB); INSERT INTO records VALUES (zeroblob(65536));");
  }
  if (alias) {
    await fs.link(databasePath, path.join(path.dirname(databasePath), "zeta.sqlite"));
  }
  const outputDir = state.path("backups");
  await fs.mkdir(outputDir);
  return { outputDir, databaseName: path.basename(databasePath) };
}
const options = (output: string) => ({
  output,
  includeWorkspace: false,
  nowMs: Date.UTC(2026, 10, 15),
});
it(
  "archives a matching captured image",
  pluginCase(async (state) => {
    const { outputDir } = await setup(state);
    const result = await createBackupArchive(options(outputDir));
    expect(
      (await listArchiveEntries(result.archivePath)).some((entry) =>
        entry.endsWith("/alpha.sqlite"),
      ),
    ).toBe(true);
  }),
);
it.each([false, true])("refuses bytes changed after capture (alias: %s)", (alias) =>
  pluginCase(async (state) => {
    const { outputDir, databaseName } = await setup(state, alias);
    const changed = changeImageAfterCapture(databaseName);
    await expect(createBackupArchive(options(outputDir))).rejects.toThrow(
      "SQLite snapshot hash mismatch",
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(await fs.readdir(outputDir)).toEqual([]);
  })(),
);
it(
  "checks a filtered image before publication",
  pluginCase(async (state) => {
    walkState.filterImage = true;
    const { outputDir, databaseName } = await setup(state);
    changeImageAfterCapture(databaseName);
    await expect(createBackupArchive(options(outputDir))).rejects.toThrow(
      "SQLite snapshot hash mismatch",
    );
    expect(await fs.readdir(outputDir)).toEqual([]);
  }),
);
it(
  "does not reuse completed-image verification from an interrupted archive attempt",
  pluginCase(async (state) => {
    walkState.failAfterImage = true;
    const { outputDir } = await setup(state);
    await expect(createBackupArchive(options(outputDir))).rejects.toThrow(
      "SQLite snapshot hash mismatch",
    );
    expect(walkState.attempts).toBe(2);
    expect(await fs.readdir(outputDir)).toEqual([]);
  }),
);

it(
  "refuses an alias changed during its copy even when the original image is restored",
  pluginCase(async (state) => {
    const { outputDir } = await setup(state, true);
    const copy = fs.copyFile;
    let changed = false;
    vi.spyOn(fs, "copyFile").mockImplementation(async (source, target, mode) => {
      const alias =
        !changed &&
        path.basename(String(source)).startsWith("openclaw-state-db-") &&
        path.basename(String(target)).startsWith("openclaw-state-db-");
      if (alias) {
        changed = true;
        await flipLastByte(String(source));
      }
      try {
        await copy(source, target, mode);
      } finally {
        if (alias) {
          await flipLastByte(String(source));
        }
      }
    });
    await expect(createBackupArchive(options(outputDir))).rejects.toThrow(
      "SQLite snapshot hash mismatch",
    );
    expect(changed).toBe(true);
    expect(await fs.readdir(outputDir)).toEqual([]);
  }),
);
