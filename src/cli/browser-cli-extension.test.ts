import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installChromeExtension } from "./browser-cli-extension";

// This test ensures the bundled extension path resolution matches the npm package layout.
// The install command should succeed without requiring any external symlinks.

describe("browser extension install", () => {
  it("installs bundled chrome extension into a state dir", async () => {
    const tmp = path.join(process.cwd(), ".tmp-test-openclaw-state", String(Date.now()));

    const result = await installChromeExtension({ stateDir: tmp });

    expect(result.path).toContain(path.join("browser", "chrome-extension"));
    expect(fs.existsSync(path.join(result.path, "manifest.json"))).toBe(true);
  });
});
