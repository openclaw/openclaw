// Control UI tests cover plugin activation behavior.
import { describe, expect, it } from "vitest";
import { isPluginEnabledInConfigSnapshot } from "./plugin-activation.ts";

function isWikiEnabled(plugins: Record<string, unknown>): boolean {
  return isPluginEnabledInConfigSnapshot({ hash: "hash-1", config: { plugins } }, "memory-wiki", {
    enabledByDefault: false,
  });
}

describe("isPluginEnabledInConfigSnapshot", () => {
  it("uses the supplied default when config has not loaded yet", () => {
    expect(
      isPluginEnabledInConfigSnapshot({ hash: "hash-1" }, "memory-wiki", {
        enabledByDefault: false,
      }),
    ).toBe(false);
  });

  it("treats bundled default-off plugins as disabled when config is present but silent", () => {
    expect(isWikiEnabled({})).toBe(false);
  });

  it("returns true when the plugin is explicitly enabled", () => {
    expect(isWikiEnabled({ entries: { "memory-wiki": { enabled: true } } })).toBe(true);
  });

  it("returns false when plugins.allow excludes the plugin", () => {
    expect(
      isWikiEnabled({
        allow: ["memory-core"],
        entries: { "memory-wiki": { enabled: true } },
      }),
    ).toBe(false);
  });

  it("keeps default-on plugins enabled when config is silent", () => {
    expect(
      isPluginEnabledInConfigSnapshot({ hash: "hash-1" }, "browser", {
        enabledByDefault: true,
      }),
    ).toBe(true);
  });
});
