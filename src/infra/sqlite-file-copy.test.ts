import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fsSafe from "./fs-safe.js";
import { copySqliteFile } from "./sqlite-file-copy.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["automatic", "admitted", "refused", "published", "EIO"] as const)(
  "preserves snapshot admission and publication when the clone is denied (%s)",
  async (scenario) => {
    const directory = directories.make("sqlite-clone-denied-");
    const source = path.join(directory, "source");
    const target = path.join(directory, "target");
    const bytes = Buffer.alloc(32768, 71);
    await fs.writeFile(source, bytes);
    const identity = await fs.stat(source, { bigint: true });
    const failure = new fsSafe.FsSafeError("helper-failed", "native file copy failed", {
      cause: Object.assign(new Error("FICLONE: denied"), {
        code: scenario === "EIO" ? "EIO" : "EPERM",
      }),
    });
    const openRoot = fsSafe.root;
    let byteCopies = 0;
    vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const root = await openRoot(...args);
      const copyIn = root.copyIn.bind(root);
      vi.spyOn(root, "copyIn").mockImplementation(async (relative, input, options) => {
        if (options?.clone === "never") {
          byteCopies++;
          return copyIn(relative, input, options);
        }
        if (scenario === "published") {
          await copyIn(relative, input, { ...options, clone: "never" });
        }
        throw failure;
      });
      return root;
    });
    const refusal = new Error("insufficient space for byte copy");
    const admission = vi.fn(async (sizeBytes: number) => {
      expect(sizeBytes).toBe(bytes.length);
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      if (scenario === "refused") {
        throw refusal;
      }
    });
    const copy = copySqliteFile(
      source,
      target,
      identity,
      scenario === "automatic" ? undefined : admission,
    );
    if (scenario === "published" || scenario === "EIO") {
      await expect(copy).rejects.toBe(failure);
      expect(admission).not.toHaveBeenCalled();
      expect(byteCopies).toBe(0);
    } else if (scenario === "refused") {
      await expect(copy).rejects.toBe(refusal);
      expect(admission).toHaveBeenCalledOnce();
      expect(byteCopies).toBe(0);
    } else {
      const receipt = await copy;
      const published = await fs.stat(target, { bigint: true });
      expect([receipt.dev, receipt.ino]).toEqual([published.dev, published.ino]);
      expect(published.ino).not.toBe(identity.ino);
      expect(await fs.readFile(target)).toEqual(bytes);
      expect(byteCopies).toBe(1);
      expect(admission).toHaveBeenCalledTimes(scenario === "automatic" ? 0 : 1);
    }
    expect(await fs.readFile(source)).toEqual(bytes);
    expect((await fs.readdir(directory)).toSorted()).toEqual(
      scenario === "refused" || scenario === "EIO" ? ["source"] : ["source", "target"],
    );
  },
);

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
