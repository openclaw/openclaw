import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLocalMediaAllowed } from "./local-media-access.js";

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

describe("assertLocalMediaAllowed", () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("treats file roots as exact matches instead of directory prefixes", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-media-"));
    const rootedDir = path.join(tempRoot, "rooted-dir");
    const childPath = path.join(rootedDir, "child.png");
    await fs.mkdir(rootedDir, { recursive: true });
    await fs.writeFile(childPath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));

    await expect(
      assertLocalMediaAllowed(childPath, [{ path: rootedDir, kind: "file", access: "ro" }]),
    ).rejects.toMatchObject({ code: "path-not-allowed" });
  });

  it("still allows the exact file when a file root points to it", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-media-"));
    const imagePath = path.join(tempRoot, "rooted.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));

    await expect(
      assertLocalMediaAllowed(imagePath, [{ path: imagePath, kind: "file", access: "ro" }]),
    ).resolves.toBeUndefined();
  });
});
