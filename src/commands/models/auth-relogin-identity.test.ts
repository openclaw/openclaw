import { describe, expect, it } from "vitest";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { resolveReloginProfileIdentity } from "./auth-relogin-identity.js";

const credential = (accountId: string): AuthProfileCredential => ({
  type: "oauth",
  provider: "fixture",
  access: "fixture-access",
  refresh: "fixture-refresh",
  expires: 2_100_000_000_000,
  accountId,
});
const profiles = [{ profileId: "fixture:new", credential: credential("a") }];
const matchesPersonalAccount = (incoming: AuthProfileCredential, existing: AuthProfileCredential) =>
  incoming.type === "oauth" &&
  existing.type === "oauth" &&
  incoming.accountId === existing.accountId;

describe("re-login identity boundaries", () => {
  it.each<
    Partial<Parameters<typeof resolveReloginProfileIdentity>[0]> & {
      name: string;
      expected?: typeof profiles;
      matcher?: typeof matchesPersonalAccount;
    }
  >([
    {
      name: "ambiguous existing accounts",
      existingProfiles: { "fixture:one": credential("a"), "fixture:two": credential("a") },
    },
    {
      name: "an unverifiable candidate",
      existingProfiles: { "fixture:one": credential("a"), "fixture:unknown": credential("b") },
      matcher: (incoming: AuthProfileCredential, existing: AuthProfileCredential) => {
        if (existing.type === "oauth" && existing.accountId === "b") {
          throw new Error("identity unavailable");
        }
        return matchesPersonalAccount(incoming, existing);
      },
    },
    {
      name: "multiple returned credentials",
      profiles: [...profiles, { ...profiles[0]!, profileId: "fixture:second" }],
    },
    {
      name: "an explicit profile override",
      requestedProfileId: "fixture:chosen",
      expected: [{ ...profiles[0]!, profileId: "fixture:chosen" }],
    },
  ])(
    "preserves identity selection for $name",
    ({
      profiles: incoming = profiles,
      existingProfiles = { "fixture:old": credential("a") },
      matcher = matchesPersonalAccount,
      requestedProfileId,
      expected = incoming,
    }) => {
      expect(
        resolveReloginProfileIdentity({
          profiles: incoming,
          existingProfiles,
          method: { matchesPersonalAccount: matcher },
          requestedProfileId,
        }).profiles,
      ).toEqual(expected);
    },
  );

  it("uses a verified shared match before checking an occupied generated ID", () => {
    const result = resolveReloginProfileIdentity({
      profiles,
      existingProfiles: { "fixture:new": credential("b"), "fixture:work": credential("a") },
      method: {
        matchesPersonalAccount: () => false,
        matchesSharedAccount: matchesPersonalAccount,
        canReplaceGeneratedProfile: () => false,
      },
    });
    expect(result.profiles[0]?.profileId).toBe("fixture:work");
    expect(() => result.validateCurrentCredential?.("fixture:work", credential("a"))).not.toThrow();
  });

  it("guards the final automatic ID against rows outside the provider's snapshot", () => {
    const result = resolveReloginProfileIdentity({
      profiles,
      existingProfiles: {},
      method: { matchesPersonalAccount, canReplaceGeneratedProfile: matchesPersonalAccount },
    });
    expect(result.validateCurrentCredential).toBeTypeOf("function");
    expect(() => result.validateCurrentCredential?.("fixture:new", undefined)).not.toThrow();
    // The Control UI shows this too, so it names no CLI-only flag.
    const collision =
      "A different account is already saved under this sign-in's profile. Remove that account, then sign in again.";
    expect(() => result.validateCurrentCredential?.("fixture:new", credential("b"))).toThrow(
      collision,
    );
    expect(() =>
      result.validateCurrentCredential?.("fixture:new", { ...credential("a"), provider: "other" }),
    ).toThrow(collision);
  });

  it("rejects a vanished identity unless the login explicitly purged it", () => {
    const result = resolveReloginProfileIdentity({
      profiles,
      existingProfiles: { "fixture:old": credential("a") },
      method: { matchesPersonalAccount },
    });
    expect(() => result.validateCurrentCredential?.("fixture:old", undefined)).toThrow(
      "identity changed",
    );
  });
});
