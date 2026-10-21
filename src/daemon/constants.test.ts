import { expect, it } from "vitest";
import {
  resolveGatewayNativeServiceIdentityConflict,
  resolveGatewayProfileSuffix,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceNameCandidates,
} from "./constants.js";

function expectCandidates(profile: string | undefined, expected: string[]) {
  expect(resolveGatewaySystemdServiceNameCandidates(profile)).toEqual(expected);
}

it("includes current default and legacy bare openclaw", () => {
  expectCandidates(undefined, ["openclaw-gateway", "openclaw"]);
  expectCandidates("default", ["openclaw-gateway", "openclaw"]);
});
it("includes current and legacy names for a named profile", () => {
  expectCandidates("lisa", ["openclaw-gateway-lisa", "openclaw-lisa"]);
});
it("omits legacy names that identify Node or another profile's gateway", () => {
  expectCandidates("node", ["openclaw-gateway-node"]);
  expectCandidates("gateway", ["openclaw-gateway-gateway"]);
  expectCandidates("gateway-lisa", ["openclaw-gateway-gateway-lisa"]);
});

it.each([
  ["darwin", "OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.gateway"],
  ["linux", "OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service"],
  ["win32", "OPENCLAW_WINDOWS_TASK_NAME", "\\OpenClaw Gateway (other)"],
] as const)("rejects %s identity overrides for named profiles", (platform, envKey, value) => {
  expect(
    resolveGatewayNativeServiceIdentityConflict(
      { OPENCLAW_PROFILE: "work", [envKey]: value },
      platform,
    ),
  ).toMatchObject({ envKey });
});

it.each([
  ["linux", { OPENCLAW_PROFILE: "work", OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-work" }],
  ["linux", { OPENCLAW_SYSTEMD_UNIT: "custom-gateway.service" }],
  ["win32", { OPENCLAW_PROFILE: "work", OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (work)" }],
] as const)("accepts canonical or default-profile %s identities: %j", (platform, env) => {
  expect(resolveGatewayNativeServiceIdentityConflict(env, platform)).toBeNull();
});

it("trims whitespace from profile suffixes", () => {
  expect(resolveGatewayProfileSuffix("  staging  ")).toBe("-staging");
});

it.each([
  [{ OPENCLAW_PROFILE: "work" }, "OpenClaw Gateway (profile: work)"],
  [{ OPENCLAW_SERVICE_VERSION: "2026.1.10" }, "OpenClaw Gateway"],
] as const)(
  "describes the service using profile, not legacy version metadata: %j",
  (env, expected) => {
    expect(resolveGatewayServiceDescription({ env })).toBe(expected);
  },
);
