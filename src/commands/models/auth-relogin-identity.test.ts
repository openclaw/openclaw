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
  it("does not choose between ambiguous existing accounts", () => {
    const result = resolveReloginProfileIdentity({
      profiles,
      existingProfiles: { "fixture:one": credential("a"), "fixture:two": credential("a") },
      matchesPersonalAccount,
    });
    expect(result.profiles).toEqual(profiles);
  });

  it("does not reuse an identity if any candidate cannot be checked", () => {
    const result = resolveReloginProfileIdentity({
      profiles,
      existingProfiles: { "fixture:one": credential("a"), "fixture:unknown": credential("b") },
      matchesPersonalAccount: (incoming, existing) => {
        if (existing.type === "oauth" && existing.accountId === "b") {
          throw new Error("identity unavailable");
        }
        return matchesPersonalAccount(incoming, existing);
      },
    });
    expect(result.profiles).toEqual(profiles);
  });

  it("does not collapse multiple returned credentials onto one profile", () => {
    const multiple = [...profiles, { ...profiles[0]!, profileId: "fixture:second" }];
    expect(
      resolveReloginProfileIdentity({
        profiles: multiple,
        existingProfiles: { "fixture:old": credential("a") },
        matchesPersonalAccount,
      }).profiles,
    ).toEqual(multiple);
  });

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

  it("keeps an explicit profile override authoritative", () => {
    expect(
      resolveReloginProfileIdentity({
        profiles,
        requestedProfileId: "fixture:chosen",
        existingProfiles: { "fixture:old": credential("a") },
        matchesPersonalAccount,
      }).profiles,
    ).toEqual([{ ...profiles[0], profileId: "fixture:chosen" }]);
  });
});
