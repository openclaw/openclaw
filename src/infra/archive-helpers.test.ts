// Tests archive helper behavior for filesystem packaging.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { resolveArchiveKind } from "./archive.js";
import { pathExists, withTimeout } from "./fs-safe.js";
import { JsonFileReadError, readJson } from "./json-files.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-archive-helper-test-");

afterEach(async () => {
  vi.useRealTimers();
  await tempDirs.cleanup();
});

describe("archive helpers", () => {
  it.each([{ input: "/tmp/file.zip", expected: "zip" }])(
    "detects archive kind for $input",
    ({ input, expected }) => {
      expect(resolveArchiveKind(input)).toBe(expected);
    },
  );

  it("rejects when archive work exceeds the timeout", async () => {
    vi.useFakeTimers();
    const late = new Promise<string>((resolve) => {
      setTimeout(() => resolve("ok"), 50);
    });
    const result = withTimeout(late, 1, "extract tar");
    const pending = expect(result).rejects.toThrow("extract tar timed out after 1ms");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  it("reads JSON files and reports file existence", async () => {
    const dir = await createTempDir();
    const jsonPath = path.join(dir, "data.json");
    const badPath = path.join(dir, "bad.json");
    await fs.writeFile(jsonPath, '{"ok":true}', "utf8");
    await fs.writeFile(badPath, "{not json", "utf8");

    await expect(readJson<{ ok: boolean }>(jsonPath)).resolves.toEqual({ ok: true });
    await expect(readJson(badPath)).rejects.toBeInstanceOf(JsonFileReadError);
    await expect(pathExists(jsonPath)).resolves.toBe(true);
    await expect(pathExists(path.join(dir, "missing.json"))).resolves.toBe(false);
  });
});
