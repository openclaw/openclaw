import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { publishVerifiedSqliteFile } from "./sqlite-snapshot.js";

it("preserves a mutable external publication source and snapshots its verified bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sqlite-publication-"));
  try {
    const directory = path.join(root, "private");
    await createPrivateSqliteDirectory(directory);
    const sourcePath = path.join(directory, "source.sqlite");
    const targetPath = path.join(directory, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const setup = new sqlite.DatabaseSync(sourcePath);
    try {
      setup.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('before');");
    } finally {
      setup.close();
    }
    const original = await fs.readFile(sourcePath);

    await publishVerifiedSqliteFile({
      sourcePath,
      sourceIdentity: await fs.lstat(sourcePath),
      targetPath,
      expectedContent: {
        sha256: createHash("sha256").update(original).digest("hex"),
        sizeBytes: original.length,
      },
      beforePublish: () => {
        const writer = new sqlite.DatabaseSync(sourcePath);
        try {
          writer.exec("UPDATE records SET value='after';");
        } finally {
          writer.close();
        }
      },
    });

    for (const [file, expected] of [
      [sourcePath, "after"],
      [targetPath, "before"],
    ] as const) {
      const database = new sqlite.DatabaseSync(file, { readOnly: true });
      try {
        expect(database.prepare("SELECT value FROM records").get()).toEqual({ value: expected });
      } finally {
        database.close();
      }
    }
    expect((await fs.readdir(directory)).toSorted()).toEqual(["snapshot.sqlite", "source.sqlite"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
