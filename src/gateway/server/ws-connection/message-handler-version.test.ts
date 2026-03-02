import { describe, it, expect } from "vitest";
import { VERSION } from "../../../version.js";

describe("message-handler version", () => {
  it("VERSION constant is a proper semver string, not a fallback like 'dev'", () => {
    expect(VERSION).toBeDefined();
    expect(typeof VERSION).toBe("string");
    expect(VERSION).not.toBe("dev");
    expect(VERSION).not.toBe("");
    // Should look like a semver (e.g. "1.2.3" or "1.2.3-beta.1")
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("message-handler imports VERSION for hello-ok frame", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(new URL("./message-handler.ts", import.meta.url), "utf-8");
    // Verify VERSION is imported from version.js
    expect(source).toContain('VERSION } from "../../../version.js"');
    // Verify hello-ok server block uses VERSION, not resolveRuntimeServiceVersion
    const helloOkMatch = source.match(/const helloOk[\s\S]*?server:\s*\{[^}]*version:\s*(\w+)/);
    expect(helloOkMatch).not.toBeNull();
    expect(helloOkMatch![1]).toBe("VERSION");
  });
});
