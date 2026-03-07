import { describe, expect, it } from "vitest";
import {
  evaluateGroupRouteAccessForPolicy,
  evaluateMatchedGroupAccessForPolicy,
  evaluateSenderGroupAccess,
  evaluateSenderGroupAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";

describe("resolveSenderScopedGroupPolicy", () => {
  it("preserves disabled policy", () => {
    expect(
      resolveSenderScopedGroupPolicy({
        groupPolicy: "disabled",
        groupAllowFrom: ["a"],
      }),
    ).toBe("disabled");
  });

  it("maps open/allowlist based on effective sender allowlist", () => {
    expect(
      resolveSenderScopedGroupPolicy({
        groupPolicy: "allowlist",
        groupAllowFrom: ["a"],
      }),
    ).toBe("allowlist");
    expect(
      resolveSenderScopedGroupPolicy({
        groupPolicy: "allowlist",
        groupAllowFrom: [],
      }),
    ).toBe("open");
  });
});

describe("evaluateSenderGroupAccessForPolicy", () => {
  it("blocks disabled policy", () => {
    const decision = evaluateSenderGroupAccessForPolicy({
      groupPolicy: "disabled",
      groupAllowFrom: ["123"],
      senderId: "123",
      isSenderAllowed: () => true,
    });

    expect(decision).toMatchObject({ allowed: false, reason: "disabled", groupPolicy: "disabled" });
  });

  it("blocks allowlist with empty list", () => {
    const decision = evaluateSenderGroupAccessForPolicy({
      groupPolicy: "allowlist",
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
});

describe("evaluateGroupRouteAccessForPolicy", () => {
  it("blocks disabled policy", () => {
    expect(
      evaluateGroupRouteAccessForPolicy({
        groupPolicy: "disabled",
        routeAllowlistConfigured: true,
        routeMatched: true,
        routeEnabled: true,
      }),
    ).toEqual({
      allowed: false,
      groupPolicy: "disabled",
      reason: "disabled",
    });
  });

  it("blocks allowlist without configured routes", () => {
    expect(
      evaluateGroupRouteAccessForPolicy({
        groupPolicy: "allowlist",
        routeAllowlistConfigured: false,
        routeMatched: false,
      }),
    ).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "empty_allowlist",
    });
  });

  it("blocks unmatched allowlist route", () => {
    expect(
      evaluateGroupRouteAccessForPolicy({
        groupPolicy: "allowlist",
        routeAllowlistConfigured: true,
        routeMatched: false,
      }),
    ).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "route_not_allowlisted",
    });
  });

  it("blocks disabled matched route even when group policy is open", () => {
    expect(
      evaluateGroupRouteAccessForPolicy({
        groupPolicy: "open",
        routeAllowlistConfigured: true,
        routeMatched: true,
        routeEnabled: false,
      }),
    ).toEqual({
      allowed: false,
      groupPolicy: "open",
      reason: "route_disabled",
    });
  });
});

describe("evaluateMatchedGroupAccessForPolicy", () => {
  it("blocks disabled policy", () => {
    expect(
      evaluateMatchedGroupAccessForPolicy({
        groupPolicy: "disabled",
        allowlistConfigured: true,
        allowlistMatched: true,
      }),
    ).toEqual({
      allowed: false,
      groupPolicy: "disabled",
      reason: "disabled",
    });
  });

  it("blocks allowlist without configured entries", () => {
    expect(
      evaluateMatchedGroupAccessForPolicy({
        groupPolicy: "allowlist",
        allowlistConfigured: false,
        allowlistMatched: false,
      }),
    ).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "empty_allowlist",
    });
  });

  it("blocks unmatched allowlist sender", () => {
    expect(
      evaluateMatchedGroupAccessForPolicy({
        groupPolicy: "allowlist",
        allowlistConfigured: true,
        allowlistMatched: false,
      }),
    ).toEqual({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "not_allowlisted",
    });
  });

  it("allows open policy", () => {
    expect(
      evaluateMatchedGroupAccessForPolicy({
        groupPolicy: "open",
        allowlistConfigured: false,
        allowlistMatched: false,
      }),
    ).toEqual({
      allowed: true,
      groupPolicy: "open",
      reason: "allowed",
    });
  });
});

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
