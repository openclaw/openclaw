import { describe, expect, it, vi } from "vitest";

const store = {
  profiles: {
    "openai:personal": { type: "oauth", provider: "openai" },
    "openai:work": { type: "oauth", provider: "openai" },
    "openai:excluded": { type: "oauth", provider: "openai" },
    "claude-cli:default": { type: "oauth", provider: "claude-cli" },
  },
};

vi.mock("../agents/auth-profiles.js", () => ({
  dedupeProfileIds: (ids: string[]) => [...new Set(ids)],
  ensureAuthProfileStoreWithoutExternalProfiles: () => store,
  resolveAuthProfileOrder: ({ provider }: { provider: string }) =>
    provider === "openai"
      ? ["openai:personal", "openai:work"]
      : provider === "claude-cli"
        ? ["claude-cli:default"]
        : [],
}));

import { __test } from "./provider-usage.load.js";

describe("provider usage profile discovery", () => {
  it("returns every eligible ordered profile and normalizes usage-owner aliases", () => {
    expect(
      __test.resolveUsageProfileRefs({
        providers: ["openai", "anthropic"],
        config: {},
      }),
    ).toEqual([
      { provider: "openai", authProfileId: "openai:personal" },
      { provider: "openai", authProfileId: "openai:work" },
      { provider: "anthropic", authProfileId: "claude-cli:default" },
    ]);
  });

  it("does not include profiles outside the requested usage providers", () => {
    expect(
      __test.resolveUsageProfileRefs({
        providers: ["anthropic"],
        config: {},
      }),
    ).toEqual([{ provider: "anthropic", authProfileId: "claude-cli:default" }]);
  });
});
