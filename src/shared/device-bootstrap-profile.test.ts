import { describe, expect, test } from "vitest";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE as owner,
  CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE as cloud,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE as node,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE as voice,
  isMobilePairingSetupBootstrapProfile as isMobile,
  isNodePairingSetupBootstrapProfile as isNode,
  isVoiceNodePairingSetupBootstrapProfile as isVoice,
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
    expectHandoff(profile(["node.exec", ...scopes("approvals", "admin")], undefined, ["node"]), {
      roles: ["node"],
      scopes: [],
    });
  });

  test("preserves the closed browser-owner handoff", () => {
    expectHandoff(
      profile(handoffScopes, "control-ui-owner", ["operator"]),
      profile(handoffScopes, "control-ui-owner", ["operator"]),
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
    expect(owner).toEqual(
      profile(
        scopes("admin", "approvals", "pairing", "questions", "read", "talk.secrets", "write"),
        "control-ui-owner",
        ["operator"],
      ),
    );
    expect([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]).toEqual(owner.scopes);
  });

  test("node setup profile carries no operator access", () => {
    expect(node).toEqual({ roles: ["node"], scopes: [] });
    expect([isNode(node), isMobile(node)]).toEqual([true, false]);
  });

  test("cloud worker setup remains node-only while retaining lifecycle purpose", () => {
    expect(cloud).toEqual(profile([], "cloud-worker", ["node"]));
    expect(isNode(cloud)).toBe(true);
  });

  test("voice-node setup profile carries only node, read, and Talk access", () => {
    expect(voice).toEqual(profile(scopes("read", "talk"), "voice-node"));
    expect([isMobile(voice), isVoice(voice)]).toEqual([false, true]);
  });

  test.each<[DeviceBootstrapProfileInput, boolean]>([
    [PAIRING_SETUP_BOOTSTRAP_PROFILE, true],
    [FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE, true],
    [profile(scopes("approvals", "read", "write")), false],
    [profile(scopes("approvals", "pairing", "read", "write")), false],
    [profile(scopes("admin", "approvals", "read", "write")), false],
  ])("recognizes only supported mobile setup profiles: %j", (input, expected) => {
    expect(isMobile(input)).toBe(expected);
  });
});
