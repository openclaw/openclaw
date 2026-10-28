import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fsSafe from "./fs-safe.js";
import { copySqliteFile } from "./sqlite-file-copy.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
let previous: ReturnType<typeof getFsSafeNativeConfig>;
beforeEach(() => {
  previous = getFsSafeNativeConfig();
});
afterEach(() => {
  configureFsSafeNative(previous);
  vi.restoreAllMocks();
});

it.each([
  "success",
  "admitted",
  "unavailable",
  "refused",
  "published",
  "EIO",
  "native-unavailable",
  "native-off-admitted",
  "noreplace-unavailable",
  "noreplace-wrapped",
  "noreplace-refused",
  "noreplace-published",
  "noreplace-cleanup",
] as const)("preserves copy admission and publication (%s)", async (scenario) => {
  const directory = directories.make("sqlite-copy-");
  const source = path.join(directory, "source"),
    target = path.join(directory, "target");
  const bytes = Buffer.alloc(32768, 71);
  await fs.writeFile(source, bytes);
  const identity = await fs.stat(source, { bigint: true });
  const nativeOff = scenario.startsWith("native-off-");
  const refused = scenario.endsWith("refused");
  const terminal = [
    "published",
    "EIO",
    "native-unavailable",
    "noreplace-published",
    "noreplace-cleanup",
  ].includes(scenario);
  const noReplace = new fsSafe.FsSafeError(
    "helper-unavailable",
    "native no-replace publication is unsupported on this filesystem",
    { details: { capability: "rename-noreplace" } },
  );
  const failure = scenario.startsWith("noreplace-")
    ? scenario === "noreplace-unavailable"
      ? noReplace
      : new fsSafe.FsSafeError("helper-unavailable", noReplace.message, {
          cause: noReplace,
          details: {
            phase: scenario === "noreplace-cleanup" ? "cleanup" : "publish",
            publication: { status: "not-published" },
          },
        })
    : scenario.endsWith("unavailable")
      ? new fsSafe.FsSafeError(
          "helper-unavailable",
          scenario === "unavailable"
            ? "native file cloning is unavailable"
            : "native no-replace publication is unavailable",
        )
      : scenario === "EIO"
        ? new fsSafe.FsSafeError("helper-failed", "native file copy failed")
        : new fsSafe.FsSafeError("unsupported-platform", "native file cloning is unavailable");
  if (nativeOff) {
    configureFsSafeNative({ mode: "off" });
  } else {
    const openRoot = fsSafe.root;
    vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const root = await openRoot(...args),
        copyIn = root.copyIn.bind(root);
      vi.spyOn(root, "copyIn").mockImplementation(async (relative, input, options) => {
        if (options?.clone === "never") {
          return copyIn(relative, input, options);
        }
        if (scenario === "success") {
          return copyIn(relative, input, { ...options, clone: "never" });
        }
        if (scenario === "published" || scenario === "noreplace-published") {
          await copyIn(relative, input, { ...options, clone: "never" });
        }
        throw failure;
      });
      return root;
    });
  }
  const refusal = new Error("insufficient space for byte copy");
  const admission = vi.fn(async (sizeBytes: number) => {
    expect(sizeBytes).toBe(bytes.length);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    if (refused) {
      throw refusal;
    }
  });
  const copy = copySqliteFile(source, target, identity, admission);
  if (terminal || refused) {
    await expect(copy).rejects.toBe(terminal ? failure : refusal);
  } else {
    const receipt = await copy,
      published = await fs.stat(target, { bigint: true });
    expect(receipt).toMatchObject({ dev: published.dev, ino: published.ino });
    expect(published.ino).not.toBe(identity.ino);
    expect(await fs.readFile(target)).toEqual(bytes);
    if (nativeOff) {
      expect(published.nlink).toBe(1n);
      await fs.writeFile(target, "independent output");
    }
  }
  expect(admission).toHaveBeenCalledTimes(terminal || scenario === "success" ? 0 : 1);
  expect(await fs.readFile(source)).toEqual(bytes);
  expect((await fs.readdir(directory)).toSorted()).toEqual(
    refused ||
      scenario === "EIO" ||
      scenario === "native-unavailable" ||
      scenario === "noreplace-cleanup"
      ? ["source"]
      : ["source", "target"],
  );
});

it("preserves an existing destination without admitting a byte copy", async () => {
  const directory = directories.make("sqlite-copy-existing-");
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  await fs.writeFile(source, "source bytes");
  await fs.writeFile(target, "existing destination");
  const admission = vi.fn();

  await expect(
    copySqliteFile(source, target, await fs.stat(source, { bigint: true }), admission),
  ).rejects.toMatchObject({ code: "already-exists" });
  expect(admission).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("source bytes");
  expect(await fs.readFile(target, "utf8")).toBe("existing destination");
});
