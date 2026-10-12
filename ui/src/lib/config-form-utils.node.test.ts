// @vitest-environment node
import { describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { configHintTranslationKey } from "../i18n/lib/config-hint-translation.ts";
import {
  hintForPath,
  localizedHintForPath,
  removePathValue,
  pruneEmptyConfigForm,
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

describe("pruneEmptyConfigForm", () => {
  it("preserves loaded redacted placeholders from the authored original", () => {
    const form = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = structuredClone(form);

    expect(pruneEmptyConfigForm(form, originalForm)).toEqual(form);
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

    expect(pruneEmptyConfigForm(form, originalForm)).toEqual(form);
  });

  it("prunes newly empty objects while retaining authored empties and array positions", () => {
    const form = {
      gateway: { remote: { nested: {} } },
      authored: {},
      items: [{ nested: {} }, "second"],
      ui: { theme: "dark" },
    };
    const original = { authored: {}, ui: { theme: "dark" } };

    expect(pruneEmptyConfigForm(form, original)).toEqual({
      authored: {},
      items: [{}, "second"],
      ui: { theme: "dark" },
    });
  });

  it("does not reindex arrays containing redacted sentinels", () => {
    const form = {
      channels: {
        slack: {
          tokens: ["__OPENCLAW_REDACTED__", "second-token"],
        },
      },
    };
    const originalForm = structuredClone(form);

    expect(pruneEmptyConfigForm(form, originalForm)).toEqual(form);
  });

  it("leaves the form unchanged without an authored original", () => {
    const form = {
      gateway: {
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    expect(pruneEmptyConfigForm(form, null)).toBe(form);
  });
});
describe("config path mutations", () => {
  it("edits and removes array entries without disturbing siblings or creating missing parents", () => {
    const form = { agents: { worker: { allowlist: [{ pattern: "old" }, { pattern: "keep" }] } } };
    setPathValue(form, ["agents", "worker", "allowlist", 0, "pattern"], "edited");
    expect(form.agents.worker.allowlist).toEqual([{ pattern: "edited" }, { pattern: "keep" }]);
    removePathValue(form, ["agents", "worker", "allowlist", 0]);
    expect(form.agents.worker.allowlist).toEqual([{ pattern: "keep" }]);
    setPathValue(form, ["agents", "worker", "allowlist", 1, "pattern"], "added");
    removePathValue(form, ["missing", "allowlist", 0]);
    expect(form).toEqual({
      agents: { worker: { allowlist: [{ pattern: "keep" }, { pattern: "added" }] } },
    });
  });
});

describe("prototype pollution prevention", () => {
  it("setPathValue creates own __proto__ data without changing prototypes", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["__proto__", "polluted"], true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(obj, "__proto__")?.value).toEqual({ polluted: true });
  });

  it("setPathValue never follows the inherited constructor", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["constructor", "prototype", "polluted"], true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(obj).toEqual({ constructor: { prototype: { polluted: true } } });
  });

  it("setPathValue supports an own prototype key", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["prototype", "bad"], true);
    expect(obj).toStrictEqual({ prototype: { bad: true } });
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
  });

  it("removePathValue never follows inherited __proto__", () => {
    const obj = { safe: 1 } as Record<string, unknown>;
    removePathValue(obj, ["__proto__", "toString"]);
    expect("toString" in {}).toBe(true);
  });

  it.each(["constructor", "prototype", "__proto__"])("removes only own %s values", (key) => {
    const obj = { [key]: { value: "remove", keep: "retained" } };
    removePathValue(obj, [key, "value"]);
    expect(obj).toEqual({ [key]: { keep: "retained" } });
    removePathValue(obj, [key]);
    expect(Object.keys(obj)).toEqual([]);
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
  });

  it("setPathValue allows normal keys", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["a", "b"], 42);
    expect((obj.a as Record<string, unknown>).b).toBe(42);
  });
});
