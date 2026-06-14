/** Tests the model-provider sensitive-header classifier. */
import { describe, expect, it } from "vitest";
import { isLikelySensitiveModelProviderHeaderName } from "./model-provider-header-policy.js";

describe("isLikelySensitiveModelProviderHeaderName", () => {
  const alwaysSensitive = [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "apikey",
    "x-auth-token",
    "auth-token",
    "x-access-token",
    "access-token",
    "x-secret-key",
    "secret-key",
  ];

  it.each(alwaysSensitive)("treats always-sensitive header %s as secret", (name) => {
    expect(isLikelySensitiveModelProviderHeaderName(name)).toBe(true);
  });

  it.each([
    ["Authorization", true],
    ["X-API-KEY", true],
    ["APIKEY", true],
    ["Secret-Key", true],
  ] as const)("matches case-insensitively for %s", (name, expected) => {
    expect(isLikelySensitiveModelProviderHeaderName(name)).toBe(expected);
  });

  it.each([
    ["x-my-token", true],
    ["X-API-KEY-V2", true],
    ["authorization", true],
    ["x-provider-secret", true],
    ["x-vault-password", true],
    ["x-service-credential", true],
  ] as const)("flags fragment/substring match %s", (name, expected) => {
    expect(isLikelySensitiveModelProviderHeaderName(name)).toBe(expected);
  });

  it.each([
    ["content-type", false],
    ["accept", false],
    ["user-agent", false],
    ["", false],
    ["   ", false],
  ] as const)("does not flag benign or empty input %j", (name, expected) => {
    expect(isLikelySensitiveModelProviderHeaderName(name)).toBe(expected);
  });
});
