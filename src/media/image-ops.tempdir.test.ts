import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredMullusiTmpDir } from "../infra/tmp-mullusi-dir.js";
import { getImageMetadata } from "./image-ops.js";

describe("image-ops temp dir", () => {
  let createdTempDir = "";

  beforeEach(() => {
    process.env.MULLUSI_IMAGE_BACKEND = "sips";
    const originalMkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix) => {
      createdTempDir = await originalMkdtemp(prefix);
      return createdTempDir;
    });
  });

  afterEach(() => {
    delete process.env.MULLUSI_IMAGE_BACKEND;
    vi.restoreAllMocks();
  });

  it("creates sips temp dirs under the secured Mullusi tmp root", async () => {
    const secureRoot = resolvePreferredMullusiTmpDir();

    await getImageMetadata(Buffer.from("image"));

    expect(fs.mkdtemp).toHaveBeenCalledTimes(1);
    expect(fs.mkdtemp).toHaveBeenCalledWith(path.join(secureRoot, "mullusi-img-"));
    expect(createdTempDir.startsWith(path.join(secureRoot, "mullusi-img-"))).toBe(true);
    await expect(fs.access(createdTempDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
