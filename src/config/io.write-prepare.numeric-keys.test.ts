import { describe, expect, it, vi } from "vitest";
import { resolvePersistCandidateForWrite } from "./io.write-prepare.js";

vi.unmock("../agents/agent-scope-config.js");

describe("explicit config writes with numeric keys", () => {
  it("preserves numeric-keyed object containers during explicit leaf writes", () => {
    const runtimeConfig = {
      plugins: {
        entries: {
          demo: {
            config: { accounts: { "0": { choice: 1 }, backup: { choice: 2 } } },
          },
        },
      },
    };
    const nextConfig = {
      plugins: {
        entries: {
          demo: {
            config: { accounts: { "0": { choice: null }, backup: { choice: 2 } } },
          },
        },
      },
    };

    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig: runtimeConfig,
        nextConfig,
        explicitSetPaths: [["plugins", "entries", "demo", "config", "accounts", "0", "choice"]],
        explicitSetValueSource: nextConfig,
      }),
    ).toEqual(nextConfig);
  });

  it("infers arrays for missing numeric-key parents during explicit leaf writes", () => {
    const explicitSetValueSource = {
      models: {
        providers: { openai: { models: [{ contextWindow: 128000 }] } },
      },
    };

    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: {},
        sourceConfig: {},
        nextConfig: {},
        explicitSetPaths: [["models", "providers", "openai", "models", "0", "contextWindow"]],
        explicitSetValueSource,
      }),
    ).toEqual(explicitSetValueSource);
  });
});
