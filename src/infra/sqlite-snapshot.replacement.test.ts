import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as durability from "./directory-durability.js";
import { deferAsync, useSqliteTempDirs } from "./sqlite-shard-lifecycle.test-support.js";
import {
  prepareVerifiedSqliteFile,
  publishVerifiedSqliteFile,
  SqliteReplacementOutcomeUnknownError,
} from "./sqlite-snapshot.js";
import { snapshotContent as content } from "./sqlite-snapshot.test-support.js";

vi.mock("./directory-durability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./directory-durability.js")>();
  return { ...actual, syncDirectory: vi.fn(actual.syncDirectory) };
});

const directories = useSqliteTempDirs(undefined, () => vi.restoreAllMocks());

async function fixture() {
  const directory = directories.make("sqlite-replacement-");
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "target.sqlite");
  for (const [file, value] of [
    [sourcePath, "new"],
    [targetPath, "old"],
  ]) {
    using database = new DatabaseSync(file!);
    database.exec(`CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('${value}');`);
  }
  const original = await fs.readFile(targetPath);
  const source = await fs.readFile(sourcePath);
  const options = {
    sourcePath,
    sourceIdentity: await fs.lstat(sourcePath, { bigint: true }),
    targetPath,
    expectedContent: content(source),
    replaceExisting: {
      expectedIdentity: await fs.lstat(targetPath, { bigint: true }),
      expectedContent: content(original),
      assertCustody: () => {},
    },
  };
  return { directory, original, source, options };
}

it.skipIf(process.platform === "win32").each(["prepared", "direct"] as const)(
  "replaces SQLite atomically with verified %s bytes and receipt",
  async (mode) => {
    const { original, source, options } = await fixture();
    let receipt;
    if (mode === "prepared") {
      const prepared = await prepareVerifiedSqliteFile(options);
      expect(await fs.readFile(options.targetPath)).toEqual(original);
      expect((await fs.stat(prepared.path)).dev).toBe((await fs.stat(options.targetPath)).dev);
      receipt = await prepared.publish();
      await prepared.cleanup();
    } else {
      receipt = await publishVerifiedSqliteFile(options);
    }
    expect(receipt).toMatchObject({ targetPath: options.targetPath, ...content(source) });
    expect(await fs.readFile(options.targetPath)).toEqual(source);
    expect(await fs.readFile(options.sourcePath)).toEqual(source);
    using database = new DatabaseSync(options.targetPath, { readOnly: true });
    expect(database.prepare("SELECT value FROM records").all()).toEqual([{ value: "new" }]);
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "custody",
    "identity",
    "content",
    "rename-before",
    "rename-after",
    "unsupported",
    "sync-after",
  ] as const)("retains recovery evidence after %s failure", async (kind) => {
  const { original, source, options } = await fixture();
  const prepared = await prepareVerifiedSqliteFile(options);
  await using _ = deferAsync(() => prepared.cleanup());
  if (kind === "custody") {
    options.replaceExisting.assertCustody = () => {
      throw new Error("custody lost");
    };
  } else if (kind === "identity") {
    await fs.rename(options.targetPath, `${options.targetPath}.original`);
    await fs.writeFile(options.targetPath, original);
  } else if (kind === "content") {
    await fs.writeFile(options.targetPath, Buffer.alloc(original.length, 42));
  } else if (kind.startsWith("rename-")) {
    const rename = fsSync.renameSync;
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (String(to) !== options.targetPath) {
        return rename(from, to);
      }
      if (kind === "rename-after") {
        rename(from, to);
      }
      throw new Error("injected rename failure");
    });
  } else {
    const sync = vi.mocked(durability.syncDirectory);
    if (kind === "unsupported") {
      sync.mockResolvedValueOnce({ status: "unsupported", code: "ENOTSUP" });
    } else {
      sync
        .mockResolvedValueOnce({ status: "synced" })
        .mockRejectedValueOnce(new Error("fsync failed"));
    }
  }
  const retained = await fs.readFile(options.targetPath);
  const attempt = prepared.publish();
  const uncertain = kind.startsWith("rename-") || kind === "sync-after";
  await expect(attempt).rejects.toThrow(
    uncertain
      ? SqliteReplacementOutcomeUnknownError
      : kind === "unsupported"
        ? "requires directory synchronization"
        : undefined,
  );
  if (kind.startsWith("rename-")) {
    await expect(attempt).rejects.toMatchObject({
      receipt: { targetPath: options.targetPath, ...content(source) },
    });
  }
  expect(await fs.readFile(options.targetPath)).toEqual(
    kind === "rename-after" || kind === "sync-after" ? source : retained,
  );
  if (["custody", "identity", "content"].includes(kind)) {
    expect(await fs.readFile(prepared.path)).toEqual(await fs.readFile(options.sourcePath));
  }
});

it.skipIf(process.platform === "win32")(
  "retains new bytes after uncertain verification",
  async () => {
    const { source, options } = await fixture();
    await expect(
      publishVerifiedSqliteFile({
        ...options,
        afterPublish: () => {
          throw new Error("late verification failure");
        },
      }),
    ).rejects.toBeInstanceOf(SqliteReplacementOutcomeUnknownError);
    expect(await fs.readFile(options.targetPath)).toEqual(source);
  },
);

it("leaves the absent-target mode exclusive", async () => {
  const { original, options } = await fixture();
  await expect(
    publishVerifiedSqliteFile({ ...options, replaceExisting: undefined }),
  ).rejects.toThrow("already exists");
  expect(await fs.readFile(options.targetPath)).toEqual(original);
  await fs.unlink(options.targetPath);
  expect(
    await publishVerifiedSqliteFile({ ...options, replaceExisting: undefined }),
  ).toBeUndefined();
});
