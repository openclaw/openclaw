import { describe, expect, it, vi } from "vitest";

const profileDisplay = vi.hoisted(() => ({ displayName: "" }));

vi.mock("../../state/user-model-accounts.js", () => ({
  readUserModelAccountSummary: () => undefined,
}));

vi.mock("../../state/user-profiles.js", () => ({
  getUserProfileDisplay: () => ({ displayName: profileDisplay.displayName }),
  resolveUserProfileId: (profileId: string) => profileId,
}));

const { resolveChatAccountSelection } = await import("./chat-account-selection.js");

describe("resolveChatAccountSelection", () => {
  it.each(["\ud83e", "\udd16"])("repairs a shared label ending in %j", (surrogate) => {
    const prefix = "x".repeat(255);
    const selection = resolveChatAccountSelection({
      authStore: {
        version: 1,
        profiles: {
          shared: {
            type: "token",
            provider: "example",
            token: "fixture-token",
            displayName: `${prefix}${surrogate}`,
          },
        },
      },
      sessionEntry: { authProfileOverride: "shared" },
    });

    expect(selection.label).toBe(`${prefix}\ufffd`);
  });

  it.each([255, 254])("keeps shared labels complete after %i ASCII units", (length) => {
    const prefix = "x".repeat(length);
    const selection = resolveChatAccountSelection({
      authStore: {
        version: 1,
        profiles: {
          shared: {
            type: "token",
            provider: "example",
            token: "fixture-token",
            displayName: `${prefix}🤖`,
          },
        },
      },
      sessionEntry: { authProfileOverride: "shared" },
    });

    expect(selection.label).toBe(length === 254 ? `${prefix}🤖` : prefix);
  });

  it("keeps personal owner labels valid at the UTF-16 limit", () => {
    const prefix = "x".repeat(255);
    profileDisplay.displayName = `${prefix}🤖`;
    const selection = resolveChatAccountSelection({
      authStore: { version: 1, profiles: {} },
      sessionEntry: {
        authProfileOverride:
          "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
      },
    });

    expect(selection.label).toBe(prefix);
  });

  it.each(["\ud83e", "\udd16"])("repairs an owner label ending in %j", (surrogate) => {
    const prefix = "x".repeat(255);
    profileDisplay.displayName = `${prefix}${surrogate}`;
    const selection = resolveChatAccountSelection({
      authStore: { version: 1, profiles: {} },
      sessionEntry: {
        authProfileOverride:
          "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
      },
    });

    expect(selection.label).toBe(`${prefix}\ufffd`);
  });
});
