import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
  type ManagedImageRecord,
} from "../gateway/managed-image-record-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  detectLegacyManagedOutgoingImages,
  migrateLegacyManagedOutgoingImages,
} from "./state-migrations.managed-outgoing-images.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;

type LegacyRecord = Omit<ManagedImageRecord, "original"> & {
  original: Omit<ManagedImageRecord["original"], "mediaId" | "mediaRoot" | "mediaSubdir"> & {
    path: string;
  };
};

function resolveLegacyManagedOutgoingImageRecordsDir(): string {
  return path.join(stateDir, "media", "outgoing", "records");
}

function attachmentId(index: number): string {
  return `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

async function writeLegacyRecord(overrides: Partial<LegacyRecord> = {}, index = 1) {
  const id = attachmentId(index);
  const recordsDir = resolveLegacyManagedOutgoingImageRecordsDir();
  const originalsDir = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR);
  await fsp.mkdir(recordsDir, { recursive: true });
  await fsp.mkdir(originalsDir, { recursive: true });
  const originalPath = path.join(originalsDir, `${id}.png`);
  await fsp.writeFile(originalPath, "image-bytes");
  const record: LegacyRecord = {
    attachmentId: id,
    sessionKey: "agent:main:main",
    agentId: "main",
    messageId: "message-1",
    createdAt: "2026-07-15T00:00:00.000Z",
    retentionClass: "history",
    alt: "Cat",
    original: {
      path: originalPath,
      contentType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: 11,
      filename: "cat.png",
    },
    ...overrides,
  };
  const sourcePath = path.join(recordsDir, `${id}.json`);
  await fsp.writeFile(sourcePath, JSON.stringify(record, null, 2));
  return { sourcePath, originalPath, record, read: () => readManagedImageRecord(id, stateDir) };
}

function migrate() {
  return migrateLegacyManagedOutgoingImages({
    detected: detectLegacyManagedOutgoingImages({
      stateDir,
      doctorOnlyStateMigrations: true,
    }),
    stateDir,
  });
}

function storedRecord(legacy: Awaited<ReturnType<typeof writeLegacyRecord>>) {
  const { path: originalPath, ...metadata } = legacy.record.original;
  return {
    ...legacy.record,
    original: {
      ...metadata,
      mediaRoot: path.join(stateDir, "media"),
      mediaId: path.basename(originalPath),
      mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
    },
  };
}

const absent = (pathname: string) =>
  expect(fsp.access(pathname)).rejects.toMatchObject({ code: "ENOENT" });
const present = (...paths: string[]) => Promise.all(paths.map((pathname) => fsp.access(pathname)));
const expiredRecord = { messageId: null, retentionClass: "transient" } as const;

function withUnlink(effect: (target: fs.PathLike) => void, after = false) {
  const unlink = fs.unlinkSync;
  using _ = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
    if (!after) {
      effect(target);
    }
    unlink(target);
    if (after) {
      effect(target);
    }
  });
  return migrate();
}

describe("legacy managed outgoing image migration", () => {
  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-migration-");
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("retains malformed UTF-8 without importing replacement characters", async () => {
    const legacy = await writeLegacyRecord({ alt: "utf8-marker" });
    const bytes = await fsp.readFile(legacy.sourcePath);
    bytes[bytes.indexOf("utf8-marker")] = 0xff;
    await fsp.writeFile(legacy.sourcePath, bytes);
    const result = migrate();
    expect(result).toMatchObject({ changes: [], warningDisposition: "recoverable" });
    expect(result.warnings.join("\n")).toContain("must be valid UTF-8");
    expect(await fsp.readFile(legacy.sourcePath)).toEqual(bytes);
    await expect(fsp.readFile(legacy.originalPath, "utf8")).resolves.toBe("image-bytes");
    await expect(legacy.read()).resolves.toBeNull();
  });

  it("reports an invalid records directory instead of silently skipping migration", async () => {
    const recordsDir = resolveLegacyManagedOutgoingImageRecordsDir();
    await fsp.mkdir(path.dirname(recordsDir), { recursive: true });
    await fsp.writeFile(recordsDir, "preserve these bytes");

    const result = migrate();

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Failed reading legacy managed outgoing image state: Error: legacy managed image records owner is not a regular directory",
    ]);
    expect(await fsp.readFile(recordsDir, "utf8")).toBe("preserve these bytes");
  });

  it("recovers claims and imports typed metadata before removing JSON", async () => {
    const legacy = await writeLegacyRecord();
    const claimPath = `${legacy.sourcePath}.doctor-importing-4242-22222222-2222-4222-8222-222222222222`;
    await fsp.rename(legacy.sourcePath, claimPath);
    const detected = detectLegacyManagedOutgoingImages({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.hasLegacy).toBe(true);
    const result = migrateLegacyManagedOutgoingImages({ detected, stateDir });
    await absent(claimPath);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 managed outgoing image record(s) → shared SQLite state",
    );
    await absent(legacy.sourcePath);
    await present(legacy.originalPath);
    expect(await legacy.read()).toEqual(storedRecord(legacy));
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    // Inspect serialized storage, independently of the typed record reader above.
    const row = database.db
      .prepare("SELECT record_json FROM managed_outgoing_image_records WHERE attachment_id = ?")
      .get(legacy.record.attachmentId);
    expect(row?.record_json).not.toContain(legacy.originalPath);
    expect(row?.record_json).not.toContain('"path"');
  });

  it("retries expired attachment cleanup without importing metadata", async () => {
    const legacy = await writeLegacyRecord(expiredRecord);
    using _ = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-15T00:16:00.000Z"));
    const remove = fs.rmSync;
    let attachmentRemovalFailed = false;
    let result: ReturnType<typeof migrate>;
    {
      using rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
        if (target === legacy.originalPath) {
          attachmentRemovalFailed = true;
          throw new Error("synthetic attachment remove failure");
        }
        return remove(target, options);
      });
      void rmSpy;
      result = migrate();
    }

    expect(attachmentRemovalFailed).toBe(true);
    expect(result.warnings.join("\n")).toContain("synthetic attachment remove failure");
    await present(legacy.sourcePath, legacy.originalPath);
    expect(await legacy.read()).toBeNull();
    const retried = migrate();
    expect(retried.warnings).toEqual([]);
    expect(retried.changes.join("\n")).toContain("Discarded 1 expired managed outgoing image");
    expect(await legacy.read()).toBeNull();
    await absent(legacy.sourcePath);
    await absent(legacy.originalPath);
  });

  it("retains all sources on atomic SQLite conflict", async () => {
    const first = await writeLegacyRecord();
    const second = await writeLegacyRecord({}, 2);
    await insertManagedImageRecord(
      {
        ...storedRecord(second),
        messageId: "different-message",
      },
      stateDir,
    );

    const result = migrate();

    expect(result.warnings.join("\n")).toContain("conflicts with shared SQLite state");
    expect(await first.read()).toBeNull();
    await present(first.sourcePath, second.sourcePath);
  });

  it("retains malformed and symlinked sources", async () => {
    const recordsDir = resolveLegacyManagedOutgoingImageRecordsDir();
    await fsp.mkdir(recordsDir, { recursive: true });
    const malformedPath = path.join(recordsDir, `${attachmentId(1)}.json`);
    await fsp.writeFile(malformedPath, "{not json");

    const malformed = migrate();
    expect(malformed.warnings.join("\n")).toContain("Failed reading legacy managed outgoing");
    await fsp.access(malformedPath);

    await fsp.rm(malformedPath);
    const targetPath = path.join(stateDir, "target.json");
    await fsp.writeFile(targetPath, "{}");
    await fsp.symlink(targetPath, malformedPath);
    const symlinked = migrate();
    expect(symlinked.warnings.join("\n")).toContain("regular file");
    expect(fs.lstatSync(malformedPath).isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(targetPath, "utf8")).toBe("{}");
  });

  it.each([
    ["root before original", true, '""'],
    ["original only", false, 'original.""'],
  ])("rejects unexpected fields before mutation: %s", async (_label, root, field) => {
    const legacy = await writeLegacyRecord();
    const original = { ...legacy.record.original, "": 1, later: 2 };
    const record = root
      ? { ...legacy.record, "": 1, later: 2, original }
      : { ...legacy.record, original };
    await fsp.writeFile(legacy.sourcePath, JSON.stringify(record));
    const result = migrate();
    expect(result.warnings).toEqual([
      `Failed reading legacy managed outgoing image state: Error: legacy managed image record has unexpected field ${field}`,
    ]);
    await fsp.access(legacy.originalPath);
    expect(fs.readdirSync(path.dirname(legacy.sourcePath))).toEqual([
      path.basename(legacy.sourcePath),
    ]);
    expect(await legacy.read()).toBeNull();
  });

  it.each([false, true])(
    "retries partial JSON cleanup after a committed import (expired second: %s)",
    async (expired) => {
      const first = await writeLegacyRecord();
      const second = await writeLegacyRecord(expired ? expiredRecord : {}, 2);
      const result = withUnlink((target) => {
        if (target === second.sourcePath) {
          throw new Error("synthetic remove failure");
        }
      });

      expect(result.warnings.join("\n")).toContain("synthetic remove failure");
      expect(await first.read()).toMatchObject({ attachmentId: first.record.attachmentId });
      await absent(first.sourcePath);
      await present(first.originalPath, second.sourcePath);
      if (expired) {
        expect(await second.read()).toBeNull();
        await absent(second.originalPath);
      } else {
        expect(await second.read()).toMatchObject({ attachmentId: second.record.attachmentId });
        await fsp.access(second.originalPath);
      }

      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      const retried = migrate();
      expect(retried.warnings).toEqual([]);
      await absent(second.sourcePath);
      expect(await first.read()).toMatchObject({ attachmentId: first.record.attachmentId });
      if (expired) {
        expect(await second.read()).toBeNull();
      } else {
        expect(await second.read()).toMatchObject({ attachmentId: second.record.attachmentId });
      }
    },
  );

  it.each([false, true])(
    "keeps changed later JSON and attachment at cleanup (expired second: %s)",
    async (expired) => {
      const first = await writeLegacyRecord();
      const second = await writeLegacyRecord(expired ? expiredRecord : {}, 2);
      const changedJson = JSON.stringify({
        ...second.record,
        messageId: "new-message",
        retentionClass: "history",
      });
      const result = withUnlink((target) => {
        if (target === first.sourcePath) {
          fs.writeFileSync(second.sourcePath, changedJson);
        }
      }, true);

      expect(result.warnings.join("\n")).toContain("source changed after doctor loaded it");
      expect(await fsp.readFile(second.sourcePath, "utf8")).toBe(changedJson);
      await fsp.access(second.originalPath);
      if (expired) {
        expect(await second.read()).toBeNull();
        expect(migrate().warnings).toEqual([]);
        expect(await second.read()).toMatchObject({ messageId: "new-message" });
      } else {
        expect(await second.read()).toMatchObject({ messageId: "message-1" });
        expect(migrate().warnings.join("\n")).toContain("conflicts with shared SQLite state");
        expect(await fsp.readFile(second.sourcePath, "utf8")).toBe(changedJson);
      }
      await fsp.access(second.originalPath);
    },
  );
});
