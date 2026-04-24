import { describe, expect, it } from "vitest";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";

describe("bundled plugin compatibility overrides", () => {
  it("does not add bundled plugins when bundled defaults are disabled", () => {
    const config = {
      plugins: {
        bundled: { mode: "disabled" as const },
        allow: ["foo"],
      },
    };

    expect(
      withBundledPluginAllowlistCompat({
        config,
        pluginIds: ["openai"],
      }),
    ).toBe(config);
    expect(
      withBundledPluginEnablementCompat({
        config,
        pluginIds: ["openai"],
      }),
    ).toBe(config);
  });

  it("does not add bundled plugins when bundled defaults require explicit selection", () => {
    const config = {
      plugins: {
        bundled: { mode: "explicit" as const },
        allow: ["foo"],
      },
    };

    expect(
      withBundledPluginAllowlistCompat({
        config,
        pluginIds: ["openai"],
      }),
    ).toBe(config);
    expect(
      withBundledPluginEnablementCompat({
        config,
        pluginIds: ["openai"],
      }),
    ).toBe(config);
  });

  it("keeps default compatibility for legacy bundled provider behavior", () => {
    const config = {
      plugins: {
        allow: ["foo"],
      },
    };

    expect(
      withBundledPluginAllowlistCompat({
        config,
        pluginIds: ["openai"],
      })?.plugins?.allow,
    ).toEqual(["foo", "openai"]);
    expect(
      withBundledPluginEnablementCompat({
        config,
        pluginIds: ["openai"],
      })?.plugins?.entries?.openai,
    ).toEqual({ enabled: true });
  });
});
