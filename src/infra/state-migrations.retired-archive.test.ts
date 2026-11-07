import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
