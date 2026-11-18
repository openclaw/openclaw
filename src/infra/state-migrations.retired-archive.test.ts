import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { archiveRetiredStateFiles } from "./state-migrations.retired-archive.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("preserves exact retired bytes and an existing different archive across retries", async () => {
  const source = path.join(dirs.make("retired-state-archive-"), "failed.json");
  const bytes = Buffer.from([0, 255, 10, 123, 13, 10]);
  await fs.writeFile(source, bytes);
  await fs.writeFile(`${source}.migrated`, "previous archive");
  const params = { label: "delivery queue", paths: [source], assertCurrent: () => {} };

  const result = await archiveRetiredStateFiles(params);

  await expect(fs.readFile(`${source}.migrated`)).resolves.toEqual(Buffer.from("previous archive"));
  await expect(fs.readFile(`${source}.migrated.2`)).resolves.toEqual(bytes);
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(result.warnings.join("\n")).toContain(`${source}.migrated.2`);
  expect(await archiveRetiredStateFiles(params)).toEqual({ changes: [], warnings: [] });
});

it("flushes a retained restart-sentinel archive before removing the source", async () => {
  const source = path.join(dirs.make("retired-state-archive-"), "restart-sentinel.json");
  const archive = `${source}.migrated`;
  const bytes = '{"retained":"restart notification"}\n';
  await fs.writeFile(source, bytes);
  await fs.writeFile(archive, bytes);
  const open = fs.open;
  let flushed = false;
  using openSpy = vi.spyOn(fs, "open");
  openSpy.mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (typeof file === "string" && path.basename(file) === path.basename(archive)) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        const readOnly =
          typeof flags === "number"
            ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
            : flags === undefined || flags === "r";
        if (readOnly) {
          throw Object.assign(new Error("EPERM: operation not permitted, fsync"), {
            code: "EPERM",
            syscall: "fsync",
          });
        }
        await sync();
        flushed = (await fs.readFile(source, "utf8")) === bytes;
      });
    }
    return handle;
  });

  await archiveRetiredStateFiles({
    label: "runtime replay and notification state",
    paths: [source],
    assertCurrent: () => {},
  });

  expect(flushed).toBe(true);
  await expect(fs.readFile(archive, "utf8")).resolves.toBe(bytes);
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it("leaves the source untouched when current write authority is lost", async () => {
  const source = path.join(dirs.make("retired-state-archive-authority-"), "failed.json");
  await fs.writeFile(source, "original bytes");
  await expect(
    archiveRetiredStateFiles({
      label: "delivery queue",
      paths: [source],
      assertCurrent: () => {
        throw new Error("lost authority");
      },
    }),
  ).rejects.toThrow("lost authority");
  await expect(fs.readFile(source, "utf8")).resolves.toBe("original bytes");
});
