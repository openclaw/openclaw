import { describe, expect, it } from "vitest";
import { selectBrowserExecutable } from "../../scripts/ensure-playwright-chromium.mjs";

describe("ensure-playwright-chromium", () => {
  it("selects bundled Playwright Chromium before system browsers", () => {
    const selected = selectBrowserExecutable({
      allowSystemBrowser: true,
      bundledPath: "/cache/chromium",
      pathExists: (path: string) => path === "/cache/chromium" || path.includes("Google Chrome"),
      runtimePlatform: "darwin",
    });

    expect(selected).toMatchObject({
      executablePath: "/cache/chromium",
      source: "playwright-bundled",
      status: "pass",
    });
  });

  it("fails closed when bundled Chromium is missing and system fallback is disabled", () => {
    const selected = selectBrowserExecutable({
      allowSystemBrowser: false,
      bundledPath: "/cache/missing-chromium",
      pathExists: () => false,
      runtimePlatform: "darwin",
    });

    expect(selected.status).toBe("blocked");
    expect(selected.source).toBe("playwright-bundled");
    expect(selected.blocker).toContain("Playwright bundled Chromium is missing");
    expect(selected.blocker).toContain("OPENCLAW_CONTROL_UI_SMOKE_ALLOW_SYSTEM_BROWSER=1");
  });

  it("allows system-browser fallback only when explicitly enabled", () => {
    const selected = selectBrowserExecutable({
      allowSystemBrowser: true,
      bundledPath: "/cache/missing-chromium",
      pathExists: (path: string) =>
        path === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      runtimePlatform: "darwin",
    });

    expect(selected).toMatchObject({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      source: "system-browser",
      status: "pass",
    });
    expect(selected.warnings[0]).toContain("lower hermeticity");
  });

  it("blocks an explicit browser path that does not exist", () => {
    const selected = selectBrowserExecutable({
      bundledPath: "/cache/chromium",
      explicitPath: "/missing/browser",
      pathExists: () => false,
    });

    expect(selected.status).toBe("blocked");
    expect(selected.blocker).toBe("Explicit browser path does not exist: /missing/browser");
  });
});
