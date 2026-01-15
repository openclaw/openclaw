import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("browser extension install", () => {
  it("installs into the state dir (never node_modules)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-ext-"));
    const { installChromeExtension } = await import("./browser-cli-extension.js");

    const sourceDir = path.resolve(process.cwd(), "assets/chrome-extension");
    const result = await installChromeExtension({ stateDir: tmp, sourceDir });

    expect(result.path).toBe(path.join(tmp, "browser", "chrome-extension"));
    expect(fs.existsSync(path.join(result.path, "manifest.json"))).toBe(true);
    expect(result.path.includes("node_modules")).toBe(false);
  });
});

