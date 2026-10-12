import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { c as createTar } from "tar";
import { afterEach, expect, test } from "vitest";
import { assertNoIncognitoArtifacts } from "../../scripts/e2e/lib/upgrade-survivor/incognito-artifacts.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const marker = "synthetic-private-transcript-marker";

test.each(["plain", "gzip", "zstd", "sqlite", "archive", "database-name"])(
  "rejects incognito leakage in %s artifacts",
  (kind) => {
    const root = tempDirs.make("incognito-artifacts-");
    const payload = Buffer.from(marker);
    const file = path.join(
      root,
      kind === "database-name" ? "incognito-openclaw-agent.sqlite-wal" : "snapshot",
    );
    if (kind === "sqlite" || kind === "archive") {
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE transcript_events(event_zstd BLOB)");
      db.prepare("INSERT INTO transcript_events VALUES (?)").run(zstdCompressSync(payload));
      db.close();
      if (kind === "archive") {
        createTar({ cwd: root, file: path.join(root, "backup.tar.gz"), gzip: true, sync: true }, [
          "snapshot",
        ]);
        fs.unlinkSync(file);
      }
    } else {
      fs.writeFileSync(
        file,
        kind === "gzip"
          ? gzipSync(payload)
          : kind === "zstd"
            ? zstdCompressSync(payload)
            : kind === "plain"
              ? payload
              : "",
      );
    }
    expect(() => assertNoIncognitoArtifacts([root], marker)).toThrow(
      kind === "database-name" ? "Incognito database artifact" : "Incognito content persisted",
    );
  },
);

test("accepts durable backups and inspects their compressed SQLite content", () => {
  const root = tempDirs.make("incognito-artifacts-");
  const db = new DatabaseSync(path.join(root, "snapshot"));
  db.exec("CREATE TABLE transcript_events(event_zstd BLOB)");
  db.prepare("INSERT INTO transcript_events VALUES (?)").run(
    zstdCompressSync(Buffer.from("durable")),
  );
  db.close();
  createTar({ cwd: root, file: path.join(root, "backup.tar.gz"), gzip: true, sync: true }, [
    "snapshot",
  ]);
  fs.unlinkSync(path.join(root, "snapshot"));
  expect(assertNoIncognitoArtifacts([root], marker)).toMatchObject({ archives: 1, databases: 1 });
});
