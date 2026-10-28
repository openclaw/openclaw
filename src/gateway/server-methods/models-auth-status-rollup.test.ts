import { expect, it } from "vitest";
import type { AuthProviderHealth } from "../../agents/auth-health.js";
import { healthProfile } from "./models-auth-status.health.test-support.js";
import { aggregateRefreshableAuthStatus } from "./models-auth-status.js";

const NOW = 1_000_000;
const expiring = NOW + 60_000;
function profile(
  type: "oauth" | "token" | "api_key",
  status: AuthProviderHealth["status"],
  expiresAt?: number,
) {
  return healthProfile("openai", type, status, `${type}-${status}`, {
    expiresAt,
    remainingMs: expiresAt === undefined ? undefined : expiresAt - NOW,
  });
}
type ScenarioOptions = Partial<AuthProviderHealth> & { expectsOAuth?: boolean };
function scenario(
  name: string,
  profiles: AuthProviderHealth["profiles"],
  expected: ReturnType<typeof aggregateRefreshableAuthStatus>,
  options: ScenarioOptions = {},
) {
  const { expectsOAuth = false, ...overrides } = options;
  const provider: AuthProviderHealth = { provider: "openai", status: "ok", profiles, ...overrides };
  return [name, provider, expected, expectsOAuth] as const;
}
const healthy = profile("oauth", "ok", expiring + 10_000_000);
const expired = profile("oauth", "expired", NOW - 1);
const expiringProfile = profile("oauth", "expiring", expiring);
const expiry = (status: AuthProviderHealth["status"], remainingMs: number) => ({
  status,
  expiresAt: NOW + remainingMs,
  remainingMs,
});

it.each([
  scenario(
    "OAuth ignores expired tokens and selects its earliest expiry",
    [healthy, profile("oauth", "ok", NOW + 1_000), profile("token", "expired")],
    expiry("ok", 1_000),
    { status: "expired" },
  ),
  scenario(
    "effective profiles exclude stale inventory",
    [expired, healthy],
    expiry("ok", 10_060_000),
    { effectiveProfiles: [healthy] },
  ),
  scenario(
    "API keys retain provider status",
    [profile("api_key", "static")],
    { status: "static" },
    { status: "static" },
  ),
  scenario("missing OAuth", [profile("oauth", "missing")], {
    status: "missing",
  }),
  scenario("expiring precedes ok", [expiringProfile, healthy], expiry("expiring", 60_000)),
  scenario("expired precedes expiring", [expired, expiringProfile], expiry("expired", -1)),
  scenario(
    "expired token replaces OAuth",
    [profile("token", "expired", NOW - 1)],
    expiry("expired", -1),
    { expectsOAuth: true },
  ),
  scenario(
    "static token replaces OAuth",
    [profile("token", "static")],
    { status: "static" },
    { expectsOAuth: true },
  ),
  scenario(
    "empty effective selection remains missing",
    [profile("token", "ok")],
    { status: "missing" },
    { effectiveProfiles: [], expectsOAuth: true },
  ),
])("aggregateRefreshableAuthStatus: %s", (_name, provider, expected, expectsOAuth) => {
  expect(aggregateRefreshableAuthStatus(provider, NOW, expectsOAuth)).toEqual(expected);
});
