import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  writeControlUiChecksums,
} from "../../scripts/control-ui-checksums.mjs";

describe("scripts/control-ui-checksums", () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-control-ui-checksums-"));
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("parses explicit input and output directories", () => {
    const parsed = parseArgs(["--input", "dist/control-ui", "--output-dir", ".artifacts/ui"]);

    expect(path.basename(parsed.inputDir)).toBe("control-ui");
    expect(path.basename(parsed.outputDir)).toBe("ui");
  });

  it("writes sorted SHA-256 sums and a JSON manifest", async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, "dist", "control-ui");
      const outputDir = path.join(dir, "artifacts");
      await fs.mkdir(path.join(inputDir, "assets"), { recursive: true });
      await fs.writeFile(path.join(inputDir, "index.html"), "<html></html>\n", "utf8");
      await fs.writeFile(path.join(inputDir, "assets", "app.js"), "console.log('ok');\n", "utf8");

      const result = await writeControlUiChecksums({ inputDir, outputDir });

      expect(result.entries.map((entry) => entry.path)).toEqual(["assets/app.js", "index.html"]);
      const sums = await fs.readFile(result.sumsPath, "utf8");
      expect(sums).toMatch(/^[a-f0-9]{64}  assets\/app\.js\n[a-f0-9]{64}  index\.html\n$/u);
      const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
      expect(manifest).toMatchObject({
        source: "dist/control-ui",
        fileCount: 2,
        files: [
          { path: "assets/app.js", bytes: 19 },
          { path: "index.html", bytes: 14 },
        ],
      });
    });
  });

  it("fails clearly when the Control UI build is missing", async () => {
    await withTempDir(async (dir) => {
      await expect(
        writeControlUiChecksums({ inputDir: path.join(dir, "missing"), outputDir: dir }),
      ).rejects.toThrow(/Run pnpm ui:build first/u);
    });
  });
});
