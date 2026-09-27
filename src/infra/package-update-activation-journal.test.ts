import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  openPackageActivationJournal,
  PACKAGE_ACTIVATION_JOURNAL,
} from "./package-update-activation-journal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const jsonColumns = ["descriptor_json", "intent_json", "publications_json"] as const;

function fixture(oversized?: (typeof jsonColumns)[number]) {
  const anchor = dirs.make("package-journal-byte-bound-");
  fs.chmodSync(anchor, 0o700);
  const file = path.join(anchor, PACKAGE_ACTIVATION_JOURNAL);
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "CREATE TABLE package_activation (slot INTEGER, revision INTEGER, phase TEXT, descriptor_json TEXT, intent_json TEXT, publications_json TEXT)",
    );
    const row = { descriptor_json: "{", intent_json: "null", publications_json: "[]" };
    if (oversized) {
      // Under one million characters, but over the one MiB byte bound.
      row[oversized] = "é".repeat(512 * 1024 + 1);
    }
    db.prepare("INSERT INTO package_activation VALUES (1, 0, 'prepared', ?, ?, ?)").run(
      row.descriptor_json,
      row.intent_json,
      row.publications_json,
    );
  } finally {
    db.close();
  }
  fs.chmodSync(file, 0o600);
  const snapshot = () => {
    const stat = fs.statSync(file);
    return {
      names: fs.readdirSync(anchor),
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      mtime: stat.mtimeMs,
      digest: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    };
  };
  return { anchor, snapshot };
}

describe("existing package journal byte bounds", () => {
  it.each(jsonColumns)(
    "refuses oversized %s before decoding without modifying the original journal",
    (column) => {
      const { anchor, snapshot } = fixture(column);
      const before = snapshot();
      expect(() => openPackageActivationJournal(anchor).read()).toThrow(
        "Package publication journal must contain one bounded operation.",
      );
      expect(snapshot()).toEqual(before);
    },
  );

  it("passes bounded bytes to the decoder and preserves malformed input", () => {
    const { anchor, snapshot } = fixture();
    const before = snapshot();
    expect(() => openPackageActivationJournal(anchor).read()).toThrow(SyntaxError);
    expect(snapshot()).toEqual(before);
  });
});
