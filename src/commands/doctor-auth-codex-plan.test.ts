import { describe, expect, it } from "vitest";
import type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";
import { buildCodexOAuthPlan } from "./doctor-auth-codex-plan.js";

function oauth(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai-codex",
    access: "raw-access-token",
    refresh: "raw-refresh-token",
    expires: Date.now() - 60_000,
    ...overrides,
  };
}

describe("buildCodexOAuthPlan", () => {
  it("groups duplicate Codex OAuth profiles without leaking token material", () => {
    const stores: Array<{ label: string; store: AuthProfileStore }> = [
      {
        label: "main",
        store: {
          version: 1,
          profiles: {
            "openai-codex:default": oauth({
              access: "main-access-secret",
              refresh: "same-refresh-secret",
              accountId: "acct-123",
              expires: Date.now() - 60_000,
            }),
          },
        },
      },
      {
        label: "compass",
        store: {
          version: 1,
          profiles: {
            "openai-codex:admin@dolbodahealth.com": oauth({
              access: "compass-access-secret",
              refresh: "same-refresh-secret",
              accountId: "acct-123",
              email: "Admin@DolbodaHealth.com",
              expires: Date.now() - 60_000,
            }),
          },
        },
      },
    ];

    const plan = buildCodexOAuthPlan({ stores });
    const serialized = JSON.stringify(plan);

    expect(plan.mode).toBe("plan");
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      kind: "account",
      profileCount: 2,
      action: "approval_required_reauth_or_repair",
    });
    expect(serialized).toContain("openai-codex:default");
    expect(serialized).toContain("openai-codex:admin@dolbodahealth.com");
    expect(serialized).not.toContain("same-refresh-secret");
    expect(serialized).not.toContain("main-access-secret");
    expect(serialized).not.toContain("compass-access-secret");
  });
});
