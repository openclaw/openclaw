import { describe, expect, it } from "vitest";
import { resolveProviderUsageApiKeyAuth } from "./provider-usage.js";

describe("resolveProviderUsageApiKeyAuth", () => {
  it("uses the current resolver's first candidate and forwards provider-owned env hints", async () => {
    const hints = ["synthetic-env-key", undefined];
    let calls = 0;
    const ctx = {
      resolveApiKeyCandidatesFromConfigAndStore: async (options?: {
        envDirect?: Array<string | undefined>;
      }) => {
        expect(options?.envDirect).toBe(hints);
        calls += 1;
        return calls === 1 ? ["first-key", "second-key"] : ["updated-key"];
      },
    };
    await expect(resolveProviderUsageApiKeyAuth(ctx, hints)).resolves.toEqual({
      token: "first-key",
    });
    await expect(resolveProviderUsageApiKeyAuth(ctx, hints)).resolves.toEqual({
      token: "updated-key",
    });
  });

  it("does not invent a fallback when no candidate resolver or token is available", async () => {
    await expect(resolveProviderUsageApiKeyAuth({}, [])).resolves.toBeNull();
    await expect(
      resolveProviderUsageApiKeyAuth(
        {
          resolveApiKeyCandidatesFromConfigAndStore: async () => [],
        },
        [],
      ),
    ).resolves.toBeNull();
    await expect(
      resolveProviderUsageApiKeyAuth(
        {
          resolveApiKeyCandidatesFromConfigAndStore: async () => ["", "not-the-first-key"],
        },
        [],
      ),
    ).resolves.toBeNull();
  });
});
