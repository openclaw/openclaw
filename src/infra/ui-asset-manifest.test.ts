import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyUiAssetManifest, writeUiAssetManifest } from "./ui-asset-manifest.js";

describe("ui asset manifest", () => {
  it("writes and verifies control-ui manifest", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "openclaw-ui-manifest-"));
    try {
      await writeFile(path.join(tmp, "index.html"), "<html></html>\n", "utf8");
      await mkdir(path.join(tmp, "assets"), { recursive: true });
      await writeFile(path.join(tmp, "assets/app.123.js"), "console.log('x')\n", "utf8");
      await writeFile(path.join(tmp, "assets/app.123.css"), "body{}\n", "utf8");

      const written = writeUiAssetManifest(tmp);
      expect(Object.keys(written.manifest.files).length).toBe(3);

      const result = verifyUiAssetManifest(tmp);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.fileCount).toBe(3);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
