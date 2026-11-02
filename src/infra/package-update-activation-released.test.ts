import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePackageActivationAnchor } from "./package-update-activation-paths.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
  runPackageActivationRecovery,
} from "./package-update-activation.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

// The v2026.9.6 publishedPackageFixture (eb377ac59e6c, executor-retained.test.ts)
// uses this in-anchor schema. Keep its format independent of the current writer.
function releasedJournal(phase = "publication-complete") {
  const root = fs.realpathSync(dirs.make("released-package-journal-"));
  const installKey = path.join(root, "openclaw");
  const anchor = resolvePackageActivationAnchor(installKey);
  fs.mkdirSync(anchor, { mode: 0o700 });
  const journal = path.join(anchor, "operation.sqlite");
  const helper = path.join(anchor, "recovery.mjs");
  const helperSource = "// Inert published-journal fixture, never executed.\n";
  fs.writeFileSync(helper, helperSource, { mode: 0o600 });
  const db = new DatabaseSync(journal);
  fs.chmodSync(journal, 0o600);
  const identity = (file: string) => {
    const stat = fs.lstatSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  const fingerprint = {
    digest: createHash("sha256").update("fixture-package").digest("hex"),
    identity: identity(root),
    version: "2026.9.4",
  };
  const operationId = randomUUID();
  const descriptor = {
    version: 1,
    operationId,
    authority: {
      databasePath: journal,
      databaseIdentity: identity(journal),
      parentIdentity: identity(anchor),
      installKey,
      owner: randomUUID(),
    },
    anchorIdentity: identity(anchor),
    journalIdentity: identity(journal),
    parentIdentity: identity(root),
    binDir: root,
    binIdentity: identity(root),
    originalStageRoot: root,
    previous: fingerprint,
    candidate: fingerprint,
    launcherRootIdentity: identity(root),
    previousLauncherRootIdentity: null,
    helperDigest: createHash("sha256").update(helperSource).digest("hex"),
    launchers: [],
  };
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE package_activation (slot INTEGER PRIMARY KEY, revision INTEGER, phase TEXT, descriptor_json TEXT, intent_json TEXT, publications_json TEXT)",
    );
    db.prepare("INSERT INTO package_activation VALUES (1,0,?,?,'null','[]')").run(
      phase,
      JSON.stringify(descriptor),
    );
  } finally {
    db.close();
  }
  const snapshot = () =>
    fs
      .readdirSync(anchor)
      .toSorted()
      .map((name) => {
        const file = path.join(anchor, name);
        const stat = fs.lstatSync(file);
        return {
          name,
          ino: stat.ino,
          mode: stat.mode,
          mtime: stat.mtimeMs,
          bytes: fs.readFileSync(file),
        };
      });
  return { installKey, anchor, journal, helper, operationId, descriptor, snapshot };
}

describe.skipIf(process.platform === "win32")("released package activation journals", () => {
  it.each(["publication-complete", "retired"])(
    "shows the original helper for %s without admitting a current writer",
    async (phase) => {
      const f = releasedJournal(phase);
      const before = f.snapshot();
      const command = `node ${f.helper} status`;
      expect(readPackageActivationReceipt(f.installKey)).toEqual({
        phase,
        operationId: f.operationId,
        installKey: f.installKey,
        recoveryCommand: command,
      });
      expect(() => assertNoPendingPackageActivation(f.installKey)).toThrow(command);
      for (const action of ["repair", "retire"] as const) {
        await expect(runPackageActivationRecovery(f.anchor, action, f.operationId)).rejects.toThrow(
          "original recovery owner",
        );
      }
      expect(f.snapshot()).toEqual(before);
      expect(fs.existsSync(`${f.anchor}.control`)).toBe(false);
    },
  );

  it("refuses a released journal naming another installation without changing it", () => {
    const f = releasedJournal();
    const db = new DatabaseSync(f.journal);
    try {
      db.prepare("UPDATE package_activation SET descriptor_json = ?").run(
        JSON.stringify({
          ...f.descriptor,
          authority: { ...f.descriptor.authority, installKey: path.join(f.anchor, "other") },
        }),
      );
    } finally {
      db.close();
    }
    const before = f.snapshot();
    expect(() => readPackageActivationReceipt(f.installKey)).toThrow("installation");
    expect(() => assertNoPendingPackageActivation(f.installKey)).toThrow("installation");
    expect(f.snapshot()).toEqual(before);
  });
});
