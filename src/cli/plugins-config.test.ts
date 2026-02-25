import { describe, expect, it } from "vitest";
import type { ActiviConfig } from "../config/config.js";
import { setPluginEnabledInConfig } from "./plugins-config.js";

describe("setPluginEnabledInConfig", () => {
  it("sets enabled flag for an existing plugin entry", () => {
    const config = {
      plugins: {
        entries: {
          alpha: { enabled: false, custom: "x" },
        },
      },
    } as ActiviConfig;

    const next = setPluginEnabledInConfig(config, "alpha", true);

    expect(next.plugins?.entries?.alpha).toEqual({
      enabled: true,
      custom: "x",
    });
  });

  it("creates a plugin entry when it does not exist", () => {
    const config = {} as ActiviConfig;

    const next = setPluginEnabledInConfig(config, "beta", false);

    expect(next.plugins?.entries?.beta).toEqual({
      enabled: false,
    });
  });
});
