import { describe, expect, it, vi } from "vitest";
import {
  resolveExtensionHostDefaultTtsProvider,
  resolveExtensionHostTtsFallbackProviders,
} from "./tts-runtime-policy.js";

vi.mock("../runtime-backend-catalog.js", () => ({
  listExtensionHostTtsRuntimeBackendCatalogEntries: vi.fn(() => [
    {
      id: "capability.runtime-backend:tts:openai",
      family: "capability.runtime-backend",
      subsystemId: "tts",
      backendId: "openai",
      source: "builtin",
      defaultRank: 0,
      selectorKeys: ["openai"],
      capabilities: ["tts.synthesis", "tts.telephony"],
    },
    {
      id: "capability.runtime-backend:tts:elevenlabs",
      family: "capability.runtime-backend",
      subsystemId: "tts",
      backendId: "elevenlabs",
      source: "builtin",
      defaultRank: 1,
      selectorKeys: ["elevenlabs"],
      capabilities: ["tts.synthesis", "tts.telephony"],
    },
    {
      id: "capability.runtime-backend:tts:edge",
      family: "capability.runtime-backend",
      subsystemId: "tts",
      backendId: "edge",
      source: "builtin",
      defaultRank: 2,
      selectorKeys: ["edge"],
      capabilities: ["tts.synthesis"],
    },
  ]),
}));

vi.mock("../tts-runtime-registry.js", () => ({
  isExtensionHostTtsProviderConfigured: vi.fn(
    (
      config: {
        configured?: string[];
      },
      provider: string,
    ) => config.configured?.includes(provider) ?? false,
  ),
}));

describe("tts-runtime-policy", () => {
  it("selects the highest-ranked configured provider by default", () => {
    expect(
      resolveExtensionHostDefaultTtsProvider({
        configured: ["elevenlabs", "edge"],
      } as never),
    ).toBe("elevenlabs");
  });

  it("falls back to edge when no configured provider is available", () => {
    expect(resolveExtensionHostDefaultTtsProvider({ configured: [] } as never)).toBe("edge");
  });

  it("keeps the preferred provider first while filtering fallback providers by configuration", () => {
    expect(
      resolveExtensionHostTtsFallbackProviders({
        config: { configured: ["openai", "edge"] } as never,
        preferredProvider: "elevenlabs",
      }),
    ).toEqual(["elevenlabs", "openai", "edge"]);
  });
});
