import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { archiveLegacyPluginStateSidecar } from "./state-migrations.storage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("legacy SQLite sidecar archival", () => {
  it.each(["unused", "identical", "different", "numbered"] as const)(
    "preserves sidecar bytes with bounded reads (%s archive)",
    (archive) => {
      const sourcePath = path.join(tempDirs.make("legacy-sidecar-archive-"), "state.sqlite");
      const sourceBytes = Buffer.alloc(1024 * 1024 + 29, 0x31);
      const differentBytes = Buffer.from(sourceBytes);
      differentBytes[differentBytes.length - 1] = 0x32;
      fs.writeFileSync(sourcePath, sourceBytes);
      fs.writeFileSync(`${sourcePath}-wal`, "retained WAL");
      if (archive !== "unused") {
        fs.writeFileSync(
          `${sourcePath}.migrated`,
          archive === "identical" ? sourceBytes : differentBytes,
        );
      }
      if (archive === "numbered") {
        fs.writeFileSync(`${sourcePath}.migrated.2`, sourceBytes);
      }
      const changes: string[] = [];
      const warnings: string[] = [];
      // Large sidecars can exceed the whole-file allocation limit while chunk reads work.
      const wholeFileRead = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("synthetic whole-file allocation limit");
      });
      try {
        archiveLegacyPluginStateSidecar({ sourcePath, changes, warnings });
      } finally {
        wholeFileRead.mockRestore();
      }

      expect(warnings).toEqual([]);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(`${sourcePath}-wal`)).toBe(false);
      expect(fs.readFileSync(`${sourcePath}-wal.migrated`, "utf8")).toBe("retained WAL");
      const usesNumberedArchive = archive === "different" || archive === "numbered";
      expect(fs.readFileSync(`${sourcePath}.migrated${usesNumberedArchive ? ".2" : ""}`)).toEqual(
        sourceBytes,
      );
      if (usesNumberedArchive) {
        expect(fs.readFileSync(`${sourcePath}.migrated`)).toEqual(differentBytes);
      }
      expect(fs.existsSync(`${sourcePath}.migrated.3`)).toBe(false);
      expect(changes.length).toBeGreaterThan(0);
    },
  );
});
