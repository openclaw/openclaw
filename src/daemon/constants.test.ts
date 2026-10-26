import { expect, it } from "vitest";
import {
  resolveGatewayNativeServiceIdentityConflict,
  resolveGatewayProfileSuffix,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceNameCandidates,
  resolveNodeServiceIdentityEnvironment,
} from "./constants.js";

it.each([
  [undefined, "ai.openclaw.node", "openclaw-node", "OpenClaw Node"],
  ["default", "ai.openclaw.node", "openclaw-node", "OpenClaw Node"],
  ["work", "ai.openclaw.node.work", "openclaw-node-work", "OpenClaw Node (work)"],
])("scopes node service identities to profile %s", (profile, launchd, systemd, windows) => {
  expect(resolveNodeServiceIdentityEnvironment({ OPENCLAW_PROFILE: profile })).toMatchObject({
    OPENCLAW_LAUNCHD_LABEL: launchd,
    OPENCLAW_SYSTEMD_UNIT: systemd,
    OPENCLAW_WINDOWS_TASK_NAME: windows,
  });
});

it.each([
  [undefined, ["openclaw-gateway", "openclaw"]],
  ["default", ["openclaw-gateway", "openclaw"]],
  ["lisa", ["openclaw-gateway-lisa", "openclaw-lisa"]],
  ["node", ["openclaw-gateway-node"]],
  ["gateway", ["openclaw-gateway-gateway"]],
  ["gateway-lisa", ["openclaw-gateway-gateway-lisa"]],
] as const)("resolves canonical and unambiguous legacy candidates for %s", (profile, expected) => {
  expect(resolveGatewaySystemdServiceNameCandidates(profile)).toEqual(expected);
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
