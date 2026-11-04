import { describe, expect, it } from "vitest";
import type { ModelAuthStatusProvider } from "../api/types.ts";
import { describeModelProviderAuth } from "./model-provider-auth-label.ts";

describe("account-specific provider plan labels", () => {
  const provider: ModelAuthStatusProvider = {
    provider: "example",
    displayName: "Example",
    status: "ok",
    profiles: [{ profileId: "example:two", type: "oauth", status: "ok" }],
    usage: {
      providerId: "example",
      authProfileId: "example:one",
      plan: "First account plan",
      windows: [],
    },
  };

  it("does not label a selected account with another account’s quota plan", () => {
    expect(describeModelProviderAuth(provider, { authProfileId: "example:two" })?.label).not.toBe(
      "First account plan",
    );
  });

  it.each([false, true])(
    "uses the measured plan for the matching account (other login: %s)",
    (otherLogin) => {
      expect(
        describeModelProviderAuth(
          {
            ...provider,
            profiles: [
              ...provider.profiles,
              ...(otherLogin
                ? [
                    {
                      profileId: "example:expired",
                      type: "oauth" as const,
                      status: "expired" as const,
                    },
                  ]
                : []),
            ],
            usage: { ...provider.usage!, authProfileId: "example:two" },
          },
          { authProfileId: "example:two" },
        )?.label,
      ).toBe("First account plan");
    },
  );
});
