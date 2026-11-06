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
    }
  >([
    {
      name: "ambiguous existing accounts",
      existingProfiles: { "fixture:one": credential("a"), "fixture:two": credential("a") },
    },
    {
      name: "an unverifiable candidate",
      existingProfiles: { "fixture:one": credential("a"), "fixture:unknown": credential("b") },
      matchesPersonalAccount: (
        incoming: AuthProfileCredential,
        existing: AuthProfileCredential,
      ) => {
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
      matchesPersonalAccount: matcher = matchesPersonalAccount,
      requestedProfileId,
      expected = incoming,
    }) => {
      expect(
        resolveReloginProfileIdentity({
          profiles: incoming,
          existingProfiles,
          matchesPersonalAccount: matcher,
          requestedProfileId,
        }).profiles,
      ).toEqual(expected);
    },
  );

  it("rejects a vanished identity unless the login explicitly purged it", () => {
    const result = resolveReloginProfileIdentity({
      profiles,
      existingProfiles: { "fixture:old": credential("a") },
      matchesPersonalAccount,
    });
    expect(() => result.validateCurrentCredential?.("fixture:old", undefined)).toThrow(
      "identity changed",
    );
  });
});
