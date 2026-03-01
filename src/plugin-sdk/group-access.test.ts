import { describe, expect, it } from "vitest";
import { evaluateSenderGroupAccess } from "./group-access.js";

describe("evaluateSenderGroupAccess", () => {
  it("defaults missing provider config to allowlist", () => {
    const decision = evaluateSenderGroupAccess({
      providerConfigPresent: false,
      configuredGroupPolicy: undefined,
      defaultGroupPolicy: "open",
      groupAllowFrom: ["123"],
      senderId: "123",
      isSenderAllowed: () => true,
    });

    expect(decision).toEqual({
      allowed: true,
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: true,
      reason: "allowed",
    });
  });

  it("blocks disabled policy", () => {
    const decision = evaluateSenderGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "disabled",
      defaultGroupPolicy: "open",
      groupAllowFrom: ["123"],
      senderId: "123",
      isSenderAllowed: () => true,
    });

    expect(decision).toMatchObject({ allowed: false, reason: "disabled", groupPolicy: "disabled" });
  });

  it("blocks allowlist with empty list", () => {
    const decision = evaluateSenderGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "allowlist",
      defaultGroupPolicy: "open",
      groupAllowFrom: [],
      senderId: "123",
      isSenderAllowed: () => true,
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "empty_allowlist",
      groupPolicy: "allowlist",
    });
  });

  it("blocks sender not allowlisted", () => {
    const decision = evaluateSenderGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "allowlist",
      defaultGroupPolicy: "open",
      groupAllowFrom: ["123"],
      senderId: "999",
      isSenderAllowed: () => false,
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "sender_not_allowlisted",
      groupPolicy: "allowlist",
    });
  });
});
