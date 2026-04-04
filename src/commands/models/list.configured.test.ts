import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveConfiguredEntries } from "./list.configured.js";

function findEntry(entries: ReturnType<typeof resolveConfiguredEntries>["entries"], key: string) {
  return entries.find((e) => e.key === key);
}

describe("resolveConfiguredEntries", () => {
  it("infers correct provider for bare model keys in agents.defaults.models from models.providers", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://google.example.com",
            models: [{ id: "gemini-2.0-flash-001" }],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "google/gemini-2.0-flash-001" },
          models: {
            "gemini-2.0-flash-001": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { entries } = resolveConfiguredEntries(cfg);

    // The bare "gemini-2.0-flash-001" key in agents.defaults.models should be
    // resolved to google/gemini-2.0-flash-001, not openai/gemini-2.0-flash-001.
    const googleEntry = findEntry(entries, "google/gemini-2.0-flash-001");
    expect(googleEntry).toBeDefined();
    expect(googleEntry?.tags.has("configured")).toBe(true);

    // Must not appear under the wrong provider.
    const wrongEntry = findEntry(entries, "openai/gemini-2.0-flash-001");
    expect(wrongEntry).toBeUndefined();
  });

  it("infers correct provider for bare model fallback values from models.providers", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://google.example.com",
            models: [{ id: "gemini-2.0-flash-001" }],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-2.0-flash-001",
            fallbacks: ["gemini-2.0-flash-001"],
          },
          models: {
            "google/gemini-2.0-flash-001": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { entries } = resolveConfiguredEntries(cfg);

    // The fallback "gemini-2.0-flash-001" should resolve to google/gemini-2.0-flash-001.
    const googleEntry = findEntry(entries, "google/gemini-2.0-flash-001");
    expect(googleEntry).toBeDefined();
    expect(googleEntry?.tags.has("fallback#1")).toBe(true);

    // Must not appear under the wrong provider.
    const wrongEntry = findEntry(entries, "openai/gemini-2.0-flash-001");
    expect(wrongEntry).toBeUndefined();
  });

  it("does not misattribute bare model keys when multiple providers configure the same model", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            models: [{ id: "gemini-2.0-flash-001" }],
          },
          "google-vertex": {
            models: [{ id: "gemini-2.0-flash-001" }],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "google/gemini-2.0-flash-001" },
          models: {
            "gemini-2.0-flash-001": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { entries } = resolveConfiguredEntries(cfg);

    // When ambiguous, fallback to DEFAULT_PROVIDER (openai) since inference
    // cannot determine a unique provider. This is the existing behavior and
    // matches the guard in inferUniqueProviderFromConfiguredModels.
    const entry = findEntry(entries, "openai/gemini-2.0-flash-001");
    expect(entry).toBeDefined();
    expect(entry?.tags.has("configured")).toBe(true);
  });

  it("keeps explicitly prefixed model keys unchanged", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            models: [{ id: "gemini-2.0-flash-001" }],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "google/gemini-2.0-flash-001" },
          models: {
            "google/gemini-2.0-flash-001": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { entries } = resolveConfiguredEntries(cfg);

    const entry = findEntry(entries, "google/gemini-2.0-flash-001");
    expect(entry).toBeDefined();
    expect(entry?.tags.has("configured")).toBe(true);
  });
});
