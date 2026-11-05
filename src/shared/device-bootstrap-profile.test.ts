import { describe, expect, test } from "vitest";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
  CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  isMobilePairingSetupBootstrapProfile,
  isNodePairingSetupBootstrapProfile,
  isVoiceNodePairingSetupBootstrapProfile,
  normalizeDeviceBootstrapHandoffProfile,
  normalizeDeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
} from "./device-bootstrap-profile.js";

const scopes = (...names: string[]) => names.map((name) => `operator.${name}`);
const handoffScopes = scopes("admin", "approvals", "pairing", "read", "talk.secrets", "write");
const profile = (
  operatorScopes: string[],
  purpose?: DeviceBootstrapProfileInput["purpose"],
  roles = ["node", "operator"],
) => ({
  roles,
  scopes: [...operatorScopes],
  ...(purpose ? { purpose } : {}),
});
function expectHandoff(input: DeviceBootstrapProfileInput, expected: DeviceBootstrapProfileInput) {
  expect(normalizeDeviceBootstrapHandoffProfile(input)).toEqual(expected);
}

describe("device bootstrap profile", () => {
  test("keeps node handoffs free of scopes", () => {
    expectHandoff(
      {
        roles: ["node"],
        scopes: ["node.exec", "operator.approvals", "operator.admin"],
      },
      { roles: ["node"], scopes: [] },
    );
  });

  test("normalizes issued handoff profiles to the bootstrap allowlist", () => {
    expectHandoff(
      profile(["node.exec", ...handoffScopes], "control-ui"),
      profile(scopes("approvals", "read", "talk.secrets", "write"), "control-ui"),
    );
  });

  test("allows admin only for closed full-access purposes", () => {
    expectHandoff(
      profile(handoffScopes, "control-ui-owner", ["operator"]),
      profile(handoffScopes, "control-ui-owner", ["operator"]),
    );

    expectHandoff(
      profile(scopes("admin", "pairing", "read"), "mobile-full"),
      profile(scopes("admin", "read", "write"), "mobile-full"),
    );
  });

  test("drops unknown bootstrap purpose codes", () => {
    expect(
      normalizeDeviceBootstrapProfile(
        JSON.parse('{"roles":["operator"],"scopes":["operator.read"],"purpose":"status"}'),
      ),
    ).toEqual({ roles: ["operator"], scopes: ["operator.read"] });
  });

  test("browser-owner profile carries the exact full Control UI handoff", () => {
    expect(CONTROL_UI_OWNER_BOOTSTRAP_PROFILE).toEqual(
      profile(
        scopes("admin", "approvals", "pairing", "questions", "read", "talk.secrets", "write"),
        "control-ui-owner",
        ["operator"],
      ),
    );
    expect([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]).toEqual(
      CONTROL_UI_OWNER_BOOTSTRAP_PROFILE.scopes,
    );
  });

  test("node setup profile carries no operator access", () => {
    expect(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({ roles: ["node"], scopes: [] });
    expect(isNodePairingSetupBootstrapProfile(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(true);
    expect(isMobilePairingSetupBootstrapProfile(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(false);
  });

  test("cloud worker setup remains node-only while retaining lifecycle purpose", () => {
    expect(CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({
      roles: ["node"],
      scopes: [],
      purpose: "cloud-worker",
    });
    expect(isNodePairingSetupBootstrapProfile(CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(
      true,
    );
  });

  test("voice-node setup profile carries only node, read, and Talk access", () => {
    expect(VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual(
      profile(scopes("read", "talk"), "voice-node"),
    );
    expect(isMobilePairingSetupBootstrapProfile(VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(
      false,
    );
    expect(
      isVoiceNodePairingSetupBootstrapProfile(VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE),
    ).toBe(true);
  });

  test.each<[DeviceBootstrapProfileInput, boolean]>([
    [PAIRING_SETUP_BOOTSTRAP_PROFILE, true],
    [FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE, true],
    [profile(scopes("approvals", "read", "write")), false],
    [profile(scopes("approvals", "pairing", "read", "write")), false],
    [profile(scopes("admin", "approvals", "read", "write")), false],
  ])("recognizes only supported mobile setup profiles: %j", (input, expected) => {
    expect(isMobilePairingSetupBootstrapProfile(input)).toBe(expected);
  });
});
