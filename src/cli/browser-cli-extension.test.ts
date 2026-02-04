import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installChromeExtension } from "./browser-cli-extension";

describe("browser extension install", () => {
  it("installs bundled chrome extension into a state dir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ext-state-"));

    try {
      const result = await installChromeExtension({ stateDir: tmp });

      expect(result.path).toBe(path.join(tmp, "browser", "chrome-extension"));
      expect(fs.existsSync(path.join(result.path, "manifest.json"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
