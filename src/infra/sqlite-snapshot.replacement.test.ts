import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as durability from "./directory-durability.js";
import {
  prepareVerifiedSqliteFile,
  publishVerifiedSqliteFile,
  SqliteReplacementOutcomeUnknownError,
} from "./sqlite-snapshot.js";

vi.mock("./directory-durability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./directory-durability.js")>();
  return { ...actual, syncDirectory: vi.fn(actual.syncDirectory) };
});

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const content = (bytes: Buffer) => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sizeBytes: bytes.length,
});

async function fixture() {
  const directory = directories.make("sqlite-replacement-");
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "target.sqlite");
  for (const [file, value] of [
    [sourcePath, "new"],
    [targetPath, "old"],
  ]) {
    const database = new DatabaseSync(file!);
    try {
      database.exec(`CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('${value}');`);
    } finally {
      database.close();
    }
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
  "atomically replaces existing SQLite with a verified %s image and receipt",
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
    const database = new DatabaseSync(options.targetPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM records").all()).toEqual([{ value: "new" }]);
    } finally {
      database.close();
    }
  },
);

it.skipIf(process.platform === "win32").each(["custody", "identity", "content"] as const)(
  "refuses %s drift before replacing the original",
  async (kind) => {
    const { original, options } = await fixture();
    const prepared = await prepareVerifiedSqliteFile(options);
    try {
      if (kind === "custody") {
        options.replaceExisting.assertCustody = () => {
          throw new Error("custody lost");
        };
      } else if (kind === "identity") {
        await fs.rename(options.targetPath, `${options.targetPath}.original`);
        await fs.writeFile(options.targetPath, original);
      } else {
        await fs.writeFile(options.targetPath, Buffer.alloc(original.length, 42));
      }
      const retained = await fs.readFile(options.targetPath);
      await expect(prepared.publish()).rejects.toThrow();
      expect(await fs.readFile(options.targetPath)).toEqual(retained);
      expect(await fs.readFile(prepared.path)).toEqual(await fs.readFile(options.sourcePath));
    } finally {
      await prepared.cleanup();
    }
  },
);

it.skipIf(process.platform === "win32").each(["before", "after"] as const)(
  "reports a failed rename %s its effect without deleting data",
  async (phase) => {
    const { original, source, options } = await fixture();
    const prepared = await prepareVerifiedSqliteFile(options);
    const rename = fsSync.renameSync;
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (String(to) !== options.targetPath) {
        return rename(from, to);
      }
      if (phase === "after") {
        rename(from, to);
      }
      throw new Error("injected rename failure");
    });
    try {
      await expect(prepared.publish()).rejects.toMatchObject({
        name: "SqliteReplacementOutcomeUnknownError",
        receipt: { targetPath: options.targetPath, ...content(source) },
      });
      expect(await fs.readFile(options.targetPath)).toEqual(phase === "before" ? original : source);
    } finally {
      await prepared.cleanup();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "reports uncertain post-rename verification without removing the new file",
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

it.skipIf(process.platform === "win32").each(["unsupported", "failed-after-rename"] as const)(
  "keeps recovery evidence when directory sync is %s",
  async (phase) => {
    const { original, source, options } = await fixture();
    const prepared = await prepareVerifiedSqliteFile(options);
    const sync = vi.mocked(durability.syncDirectory);
    if (phase === "unsupported") {
      sync.mockResolvedValueOnce({ status: "unsupported", code: "ENOTSUP" });
    } else {
      sync
        .mockResolvedValueOnce({ status: "synced" })
        .mockRejectedValueOnce(new Error("fsync failed"));
    }
    try {
      const attempt = prepared.publish();
      if (phase === "unsupported") {
        await expect(attempt).rejects.toThrow("requires directory synchronization");
      } else {
        await expect(attempt).rejects.toBeInstanceOf(SqliteReplacementOutcomeUnknownError);
      }
      expect(await fs.readFile(options.targetPath)).toEqual(
        phase === "unsupported" ? original : source,
      );
    } finally {
      await prepared.cleanup();
    }
  },
);
