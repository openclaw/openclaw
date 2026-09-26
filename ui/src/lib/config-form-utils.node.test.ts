// @vitest-environment node
import { describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { configHintTranslationKey } from "../i18n/lib/config-hint-translation.ts";
import {
  hintForPath,
  localizedHintForPath,
  removePathValue,
  sanitizeRedactedFormForSubmit,
  setPathValue,
} from "./config-form-utils.ts";

describe("hintForPath", () => {
  it("localizes the matched wildcard while preserving direct precedence and metadata", async () => {
    const wildcard = {
      label: "Plugin Enabled",
      help: "Enable this plugin",
      advanced: true,
      order: 7,
    };
    const direct = { label: "Specific plugin", sensitive: true };
    const hints = {
      "plugins.entries.*.enabled": wildcard,
      "plugins.entries.specific.enabled": direct,
    };
    const key = configHintTranslationKey("plugins.entries.*.enabled", "label", wildcard.label);
    i18n.registerTranslation("tr", {
      configHints: {
        "plugins%2Eentries%2E*%2Eenabled": { label: { [key.split(".").at(-1)!]: "Eklenti etkin" } },
      },
    });
    await i18n.setLocale("tr");
    try {
      expect(localizedHintForPath(["plugins", "entries", "demo", "enabled"], hints)).toEqual({
        ...wildcard,
        label: "Eklenti etkin",
      });
      expect(localizedHintForPath(["plugins", "entries", "specific", "enabled"], hints)).toEqual(
        direct,
      );
      expect(hintForPath(["plugins", "entries", "demo", "enabled"], hints)).toBe(wildcard);
      expect(localizedHintForPath(["missing"], hints)).toBeUndefined();
      expect(
        localizedHintForPath(["plugins", "entries", "demo", "enabled"], {
          "plugins.entries.*.enabled": { label: "Enable this plugin now" },
        })?.label,
      ).toBe("Enable this plugin now");
    } finally {
      await i18n.setLocale("en");
    }
    expect(localizedHintForPath(["plugins", "entries", "demo", "enabled"], hints)).toEqual(
      wildcard,
    );
  });

  it("does not rescan wildcard hints for each path lookup", () => {
    let catalogScans = 0;
    const hints = new Proxy(
      {
        "plugins.entries.*.enabled": { label: "Plugin Enabled" },
      },
      {
        ownKeys(target) {
          catalogScans += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(hintForPath(["plugins", "entries", "voice-call", "enabled"], hints)?.label).toBe(
      "Plugin Enabled",
    );
    expect(hintForPath(["plugins", "missing"], hints)).toBeUndefined();
    expect(hintForPath(["channels", "missing"], hints)).toBeUndefined();
    expect(catalogScans).toBeLessThanOrEqual(1);
  });
});

describe("sanitizeRedactedFormForSubmit", () => {
  it("drops loaded redacted placeholders for paths missing from original raw config", () => {
    const form = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };

    expect(
      sanitizeRedactedFormForSubmit(form, originalForm, { gateway: { mode: "remote" } }),
    ).toEqual({
      gateway: {
        mode: "remote",
      },
    });
  });

  it("preserves loaded redacted placeholders that exist in original raw config", () => {
    const form = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = structuredClone(form);

    expect(
      sanitizeRedactedFormForSubmit(form, originalForm, {
        gateway: { mode: "remote", remote: { token: "__OPENCLAW_REDACTED__" } },
      }),
    ).toEqual(form);
  });

  it("keeps newly entered sentinel literals so gateway validation rejects them", () => {
    const form = {
      gateway: {
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = {
      gateway: {
        remote: {},
      },
    };

    expect(sanitizeRedactedFormForSubmit(form, originalForm, { gateway: { remote: {} } })).toEqual(
      form,
    );
  });

  it("prunes empty object parents when they are absent from original raw config", () => {
    const form = {
      gateway: {
        remote: {
          nested: {
            token: "__OPENCLAW_REDACTED__",
          },
        },
      },
      ui: { theme: "dark" },
    };
    const originalForm = structuredClone(form);

    expect(sanitizeRedactedFormForSubmit(form, originalForm, { ui: { theme: "dark" } })).toEqual({
      ui: { theme: "dark" },
    });
  });

  it("does not reindex arrays when a loaded scalar array sentinel is unrestorable", () => {
    const form = {
      channels: {
        slack: {
          tokens: ["__OPENCLAW_REDACTED__", "second-token"],
        },
      },
    };
    const originalForm = structuredClone(form);

    expect(
      sanitizeRedactedFormForSubmit(form, originalForm, {
        channels: { slack: { tokens: ["second-token"] } },
      }),
    ).toEqual(form);
  });

  it("leaves the form unchanged when the original raw config has no parsed snapshot", () => {
    const form = {
      gateway: {
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = structuredClone(form);

    expect(sanitizeRedactedFormForSubmit(form, originalForm, null)).toEqual(form);
  });
});
describe("prototype pollution prevention", () => {
  it("setPathValue rejects __proto__ in path", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["__proto__", "polluted"], true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
  });

  it("setPathValue rejects constructor in path", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["constructor", "prototype", "polluted"], true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("setPathValue rejects prototype in path", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["prototype", "bad"], true);
    expect(obj).toStrictEqual({});
  });

  it("removePathValue rejects __proto__ in path", () => {
    const obj = { safe: 1 } as Record<string, unknown>;
    removePathValue(obj, ["__proto__", "toString"]);
    expect("toString" in {}).toBe(true);
  });

  it("setPathValue allows normal keys", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["a", "b"], 42);
    expect((obj.a as Record<string, unknown>).b).toBe(42);
  });
});
