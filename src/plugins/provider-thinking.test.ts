import { afterEach, describe, expect, test } from "vitest";
import {
  resolveProviderThinkingProfile,
  resolveProviderXHighThinking,
} from "./provider-thinking.js";

const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type TestGlobal = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    activeRegistry?: {
      providers?: Array<{
        provider: {
          id: string;
          supportsXHighThinking?: () => boolean | undefined;
          resolveThinkingProfile?: () =>
            | { levels: Array<{ id: "off" | "high" | "xhigh" }> }
            | null
            | undefined;
        };
      }>;
    };
  };
};

describe("provider thinking hooks", () => {
  afterEach(() => {
    delete (globalThis as TestGlobal)[PLUGIN_REGISTRY_STATE];
  });

  test("continues past matching providers without thinking hooks", () => {
    (globalThis as TestGlobal)[PLUGIN_REGISTRY_STATE] = {
      activeRegistry: {
        providers: [
          { provider: { id: "openai-codex" } },
          {
            provider: {
              id: "openai-codex",
              supportsXHighThinking: () => true,
              resolveThinkingProfile: () => ({
                levels: [{ id: "off" }, { id: "high" }, { id: "xhigh" }],
              }),
            },
          },
        ],
      },
    };

    expect(
      resolveProviderXHighThinking({
        provider: "openai-codex",
        context: { provider: "openai-codex", modelId: "gpt-5.5" },
      }),
    ).toBe(true);
    expect(
      resolveProviderThinkingProfile({
        provider: "openai-codex",
        context: { provider: "openai-codex", modelId: "gpt-5.5" },
      }),
    ).toEqual({ levels: [{ id: "off" }, { id: "high" }, { id: "xhigh" }] });
  });
});
