import { describe, expect, it } from "vitest";
import { parseBrowserHttpUrl, redactCdpUrl } from "./browser-cdp.js";
import { resolveBrowserControlAuth } from "./browser-control-auth.js";
import {
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  resolveBrowserConfig,
} from "./browser-profiles.js";

describe("plugin-sdk browser subpaths", () => {
  it("keeps browser profile helpers available on the narrow subpath", () => {
    const resolved = resolveBrowserConfig(undefined, { gateway: { port: 18789 } });
    expect(DEFAULT_OPENCLAW_BROWSER_ENABLED).toBe(true);
    expect(DEFAULT_BROWSER_DEFAULT_PROFILE_NAME).toBe("openclaw");
    expect(resolved.controlPort).toBeTypeOf("number");
  });

  it("parses and redacts CDP urls on the dedicated CDP subpath", () => {
    const parsed = parseBrowserHttpUrl("http://user:pass@127.0.0.1:9222/", "browser.cdpUrl");
    expect(parsed.port).toBe(9222);
    expect(redactCdpUrl(parsed.normalized)).toBe("http://127.0.0.1:9222");
  });

  it("resolves browser control auth on the dedicated auth subpath", () => {
    expect(
      resolveBrowserControlAuth(
        {
          gateway: {
            auth: {
              token: "token-1",
            },
          },
        },
        {},
      ),
    ).toEqual({ token: "token-1", password: undefined });
  });
});
