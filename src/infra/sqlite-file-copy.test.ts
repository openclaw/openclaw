import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copySqliteFile } from "./sqlite-file-copy.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it.each([true, false])(
  "admits a byte fallback before creating output (admitted=%s)",
  async (admitted) => {
    const directory = directories.make("sqlite-copy-admission-");
    const source = path.join(directory, "source");
    const target = path.join(directory, "target");
    const bytes = Buffer.alloc(32768, 71);
    await fs.writeFile(source, bytes);
    const identity = await fs.stat(source, { bigint: true });
    const previous = getFsSafeNativeConfig();
    const refusal = new Error("destination cannot admit the byte copy");
    let admissions = 0;
    try {
      configureFsSafeNative({ mode: "off" });
      const copy = copySqliteFile(source, target, identity, async (sizeBytes) => {
        admissions++;
        expect(sizeBytes).toBe(bytes.length);
        await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
        if (!admitted) {
          throw refusal;
        }
      });
      if (admitted) {
        const receipt = await copy;
        const published = await fs.stat(target, { bigint: true });
        expect([receipt.dev, receipt.ino]).toEqual([published.dev, published.ino]);
        expect(published.ino).not.toBe(identity.ino);
        expect(published.nlink).toBe(1n);
        expect(await fs.readFile(target)).toEqual(bytes);
        await fs.writeFile(target, "independent output");
      } else {
        await expect(copy).rejects.toBe(refusal);
      }
    } finally {
      configureFsSafeNative(previous);
    }
    expect(admissions).toBe(1);
    expect(await fs.readFile(source)).toEqual(bytes);
    expect((await fs.readdir(directory)).toSorted()).toEqual(
      admitted ? ["source", "target"] : ["source"],
    );
  },
);
