import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ContentScript = {
  matches?: string[];
  js?: string[];
  run_at?: string;
  world?: string;
  all_frames?: boolean;
};

type ExtensionManifest = {
  background?: { service_worker?: string; type?: string };
  permissions?: string[];
  content_scripts?: ContentScript[];
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

  it("includes scripting permission for content script injection", () => {
    const permissions = readManifest().permissions ?? [];
    expect(permissions).toContain("scripting");
  });

  it("declares kill-beforeunload content script in MAIN world at document_start", () => {
    const scripts = readManifest().content_scripts ?? [];
    const killBeforeunload = scripts.find(
      (s) => s.js?.includes("kill-beforeunload.js"),
    );
    expect(killBeforeunload).toBeDefined();
    expect(killBeforeunload?.world).toBe("MAIN");
    expect(killBeforeunload?.run_at).toBe("document_start");
    expect(killBeforeunload?.matches).toContain("<all_urls>");
  });

  it("declares content script for DOM helpers at document_idle in all frames", () => {
    const scripts = readManifest().content_scripts ?? [];
    const content = scripts.find((s) => s.js?.includes("content.js"));
    expect(content).toBeDefined();
    expect(content?.run_at).toBe("document_idle");
    expect(content?.all_frames).toBe(true);
    expect(content?.matches).toContain("<all_urls>");
  });
});
