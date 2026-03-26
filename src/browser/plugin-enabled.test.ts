import { describe, expect, it } from "vitest";
import { isDefaultBrowserPluginEnabled } from "../../extensions/browser/src/browser/plugin-enabled.js";
import type { OpenClawConfig } from "../config/config.js";

describe("isDefaultBrowserPluginEnabled", () => {
  it("defaults to enabled", () => {
    expect(isDefaultBrowserPluginEnabled({} as OpenClawConfig)).toBe(true);
  });

  it("respects explicit plugin disablement", () => {
    expect(
      isDefaultBrowserPluginEnabled({
        plugins: {
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig),
    ).toBe(false);
  });
});
