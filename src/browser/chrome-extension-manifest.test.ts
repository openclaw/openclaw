import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ExtensionManifest = {
  background?: { service_worker?: string; type?: string };
  permissions?: string[];
};

function readManifest(): ExtensionManifest {
  const path = resolve(process.cwd(), "assets/chrome-extension/manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as ExtensionManifest;
}

describe("chrome extension manifest", () => {
  it("keeps background worker configured as module", () => {
    const manifest = readManifest();
    expect(manifest.background?.service_worker).toBe("background.js");
    expect(manifest.background?.type).toBe("module");
  });

  it("includes resilience permissions", () => {
    const permissions = readManifest().permissions ?? [];
    expect(permissions).toContain("alarms");
    expect(permissions).toContain("webNavigation");
    expect(permissions).toContain("storage");
    expect(permissions).toContain("debugger");
  });
});
