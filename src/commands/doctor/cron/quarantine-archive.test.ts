import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { archiveLegacyCronFile } from "./quarantine-archive.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "preserves quarantine bytes across cross-device archival (changed=%s)",
  async (changed) => {
    const filePath = path.join(tempDirs.make("cron-quarantine-archive-"), "jobs-quarantine.json");
    const source = '{"version":1,"jobs":[{"reason":"invalid-schedule","raw":"preserve"}]}';
    const archivePath = `${filePath}.migrated.2`;
    const sourceMtime = new Date("2026-07-02T03:04:05.000Z");
    await fs.writeFile(filePath, source);
    await fs.writeFile(`${filePath}.migrated`, "earlier archive");
    await fs.chmod(filePath, 0o640);
    await fs.utimes(filePath, sourceMtime, sourceMtime);
    vi.spyOn(fs, "rename").mockRejectedValue(
      Object.assign(new Error("cross-device rename"), { code: "EXDEV" }),
    );
    const copyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      await copyFile(from, to, mode);
      if (changed) {
        await fs.writeFile(filePath, "new operator bytes");
      }
    });
    const result = await archiveLegacyCronFile(
      filePath,
      createHash("sha256").update(source).digest("hex"),
    );
    expect(await fs.readFile(`${filePath}.migrated`, "utf8")).toBe("earlier archive");
    if (changed) {
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("changed during archival"),
      });
      expect(await fs.readFile(filePath, "utf8")).toBe("new operator bytes");
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result).toEqual({ ok: true, archivePath });
      expect(await fs.readFile(archivePath, "utf8")).toBe(source);
      const stat = await fs.stat(archivePath);
      expect(stat.mtimeMs).toBe(sourceMtime.getTime());
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o640);
      }
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);
