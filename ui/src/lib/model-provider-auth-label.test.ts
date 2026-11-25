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

it.each([
  [{ kind: "subscription", plan: "Max" }, "Max"],
  [{ kind: "subscription" }, "Subscription"],
  [{ kind: "api" }, "API"],
  [{ kind: "native" }, "Native login"],
] as const)("describes native billing without saved profiles: %j", (nativeAuth, label) => {
  const provider: ModelAuthStatusProvider = {
    provider: "claude-cli",
    displayName: "Claude CLI",
    status: "ok",
    profiles: [],
    nativeAuth,
  };
  expect(describeModelProviderAuth(provider)).toEqual({ kind: nativeAuth.kind, label });
});

it("does not hide native login because another provider's account is selected", () => {
  expect(
    describeModelProviderAuth(
      {
        provider: "claude-cli",
        displayName: "Claude CLI",
        status: "ok",
        profiles: [],
        nativeAuth: { kind: "native" },
      },
      { authProfileId: "unrelated:saved" },
    ),
  ).toEqual({ kind: "native", label: "Native login" });
});

it("uses native login even when the saved-profile rollup expects an absent OAuth profile", () => {
  const provider: ModelAuthStatusProvider = {
    provider: "claude-cli",
    displayName: "Claude CLI",
    status: "missing",
    profiles: [],
    nativeAuth: { kind: "subscription" },
  };
  expect(describeModelProviderAuth(provider)?.label).toBe("Subscription");
  expect(
    describeModelProviderAuth(provider, {
      authProfileId: "anthropic:missing",
      projection: "available-credentials",
    })?.kind,
  ).toBe("missing");
});
