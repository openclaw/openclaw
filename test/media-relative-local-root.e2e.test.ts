import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWebMedia } from "../src/web/media.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("media local roots e2e", () => {
  it("loads relative media paths from explicit local root even when cwd is unrelated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-root-"));
    cleanup.push(root);
    const deliverablesDir = path.join(root, "deliverables");
    await fs.mkdir(deliverablesDir, { recursive: true });
    const filePath = path.join(deliverablesDir, "hello.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const relPath = "deliverables/hello.txt";
    const originalCwd = process.cwd();
    process.chdir(path.parse(originalCwd).root);
    try {
      const media = await loadWebMedia(relPath, {
        maxBytes: 1024 * 1024,
        localRoots: [root],
      });
      expect(media.kind).toBe("document");
      expect(media.buffer.toString("utf8")).toBe("hello");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
