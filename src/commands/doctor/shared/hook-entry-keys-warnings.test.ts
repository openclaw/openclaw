import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { collectUnknownHookEntryKeysWarnings } from "./hook-entry-keys-warnings.js";

function makeConfig(overrides: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    hooks: { internal: {} },
    ...overrides,
  } as OpenClawConfig;
}

describe("collectUnknownHookEntryKeysWarnings", () => {
  it("returns empty when no entries are configured", () => {
    expect(collectUnknownHookEntryKeysWarnings(makeConfig({ hooks: { internal: {} } }))).toEqual(
      [],
    );
  });

  it("returns empty for entries that only use known keys (enabled, env)", () => {
    const cfg = makeConfig({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "bootstrap-extra-files": {
              enabled: true,
              env: { FOO: "bar" },
            },
          },
        },
      },
    });
    expect(collectUnknownHookEntryKeysWarnings(cfg)).toEqual([]);
  });

  it("warns when entry contains unknown 'handler' key", () => {
    const cfg = makeConfig({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "self-improve": {
              enabled: true,
              handler: "./hooks/self-improve.ts",
            },
          },
        },
      },
    });
    const warnings = collectUnknownHookEntryKeysWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('hooks.internal.entries["self-improve"]');
    expect(warnings[0]).toContain('"handler"');
  });

  it("warns when entry contains unknown 'extraDirs' key directly under entry", () => {
    const cfg = makeConfig({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "my-hook": {
              enabled: true,
              extraDirs: ["./extra-hooks"],
            },
          },
        },
      },
    });
    const warnings = collectUnknownHookEntryKeysWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"extraDirs"');
  });

  it("warns when entry contains multiple unknown keys", () => {
    const cfg = makeConfig({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "my-hook": {
              enabled: true,
              handler: "./handler.ts",
              extraDirs: ["./dir"],
              installs: { someId: { id: "someId", hooks: ["my-hook"] } },
            },
          },
        },
      },
    });
    const warnings = collectUnknownHookEntryKeysWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"handler"');
    expect(warnings[0]).toContain('"extraDirs"');
    expect(warnings[0]).toContain('"installs"');
  });

  it("handles multiple entries independently", () => {
    const cfg = makeConfig({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            hook1: { enabled: true, handler: "./h1.ts" },
            hook2: { enabled: true, env: { KEY: "val" } },
            hook3: { enabled: true, extraDirs: ["./d"] },
          },
        },
      },
    });
    const warnings = collectUnknownHookEntryKeysWarnings(cfg);
    expect(warnings).toHaveLength(2); // hook1 and hook3 warn
    expect(warnings[0]).toContain("hook1");
    expect(warnings[1]).toContain("hook3");
  });

  it("returns empty when entries is undefined", () => {
    const cfg = makeConfig({ hooks: { internal: { enabled: true } } });
    expect(collectUnknownHookEntryKeysWarnings(cfg)).toEqual([]);
  });

  it("returns empty when hooks.internal is undefined", () => {
    const cfg = makeConfig({});
    expect(collectUnknownHookEntryKeysWarnings(cfg)).toEqual([]);
  });
});
