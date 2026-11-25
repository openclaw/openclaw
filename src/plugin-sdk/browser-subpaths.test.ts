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

  it.each([
    "http://127.0.0.1:80/json/version",
    "http://127.0.0.1:80/path@name",
    "https://browser.example:443/cdp?session=user@example.com",
    "ws://browser.example:80/cdp#user@example.com",
    "wss://user:pass@[::1]:443/cdp?session=user@example.com",
    "http://user:pass@127.0.0.1:80/path@name",
    "http://127.0.0.1:9222/path@name",
  ])("preserves the authority's explicit port in %s", (url) => {
    const parsed = parseBrowserHttpUrl(url, "browser.cdpUrl");
    expect(parsed.hasExplicitPort).toBe(true);
    expect(parsed.normalizedWithPort).toBe(url);
  });

  it("rejects explicit port zero", () => {
    expect(() => parseBrowserHttpUrl("http://127.0.0.1:0", "browser.cdpUrl")).toThrow(
      /invalid port/,
    );
  });
});
