// Browser subpath tests cover plugin SDK browser subpath exports and lazy boundaries.
import { describe, expect, it } from "vitest";
import { parseBrowserHttpUrl, redactCdpUrl } from "./browser-cdp.js";

describe("plugin-sdk browser subpaths", () => {
  it("parses and redacts CDP urls on the dedicated CDP subpath", () => {
    const parsed = parseBrowserHttpUrl("http://user:pass@127.0.0.1:9222/", "browser.cdpUrl");
    expect(parsed.port).toBe(9222);
    expect(redactCdpUrl(parsed.normalized)).toBe("http://127.0.0.1:9222");
    expect(redactCdpUrl("wss://browser.example/cdp?token=browser-token&view=full")).toBe(
      "wss://browser.example/cdp?token=***&view=full",
    );
  });

  it("preserves explicit default ports and rejects explicit port zero", () => {
    const parsed = parseBrowserHttpUrl("http://127.0.0.1:80/json/version", "browser.cdpUrl");
    expect(parsed.hasExplicitPort).toBe(true);
    expect(parsed.normalizedWithPort).toBe("http://127.0.0.1:80/json/version");
    expect(() => parseBrowserHttpUrl("http://127.0.0.1:0", "browser.cdpUrl")).toThrow(
      /invalid port/,
    );
  });
});
