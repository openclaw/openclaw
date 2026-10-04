import { describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PairedDevice } from "../infra/device-pairing.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { isApprovalRecordVisibleToClient } from "./server-methods/approval-record-lookup.js";
import { listCurrentWebPushTargets, webPushTargetClient } from "./web-push-authority.js";

const OPERATOR_SCOPES = ["operator.read", "operator.write", "operator.approvals"] as const;

function pairedOperator(deviceId: string, revokedAtMs?: number): PairedDevice {
  const scopes = [...OPERATOR_SCOPES];
  return {
    deviceId,
    publicKey: `public-${deviceId}`,
    role: "operator",
    roles: ["operator"],
    approvedScopes: scopes,
    createdAtMs: 1,
    approvedAtMs: 1,
    tokens: {
      operator: {
        token: `token-${deviceId}`,
        role: "operator",
        scopes,
        createdAtMs: 1,
        ...(revokedAtMs ? { revokedAtMs } : {}),
      },
    },
  } as PairedDevice;
}

function boundSubscription(
  deviceId: string,
  userProfileId: string | null,
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: { enabled: true, label: "" },
  };
}

function profileCatalog(identities: Record<string, { role: string | null }>) {
  return {
    readCurrentIdentity: (profileId: string) => {
      const identity = identities[profileId];
      return identity
        ? { profileId, role: identity.role, aliases: new Set([profileId]) }
        : undefined;
    },
    release: () => {},
  } as unknown as Parameters<typeof listCurrentWebPushTargets>[0]["profile"];
}

function rolesConfig(): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: ["main"],
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
}

function targets(params: {
  cfg: OpenClawConfig;
  deviceId: string;
  userProfileId: string;
  role: string | null;
  revokedAtMs?: number;
  requiredScopes?: readonly string[];
}) {
  return listCurrentWebPushTargets({
    cfg: params.cfg,
    subscriptions: [boundSubscription(params.deviceId, params.userProfileId)],
    pairedDevices: [pairedOperator(params.deviceId, params.revokedAtMs)],
    profile: profileCatalog({ [params.userProfileId]: { role: params.role } }),
    preferences: new Map(),
    sessions: new Map(),
    requiredScopes: params.requiredScopes ?? ["operator.approvals"],
  });
}

describe("web push recipient authority with gateway roles", () => {
  it("keeps the unrestricted gateway owner eligible when roles are configured", () => {
    const owner = targets({
      cfg: rolesConfig(),
      deviceId: "owner-device",
      userProfileId: GATEWAY_OWNER_PROFILE_ID,
      role: null,
    });

    expect(owner.map((target) => target.subscription.subscriptionId)).toEqual([
      "subscription-owner-device",
    ]);
    expect(owner[0]?.scopes).toEqual(["operator.approvals"]);
  });

  it("still denies a named role that does not hold the required scope", () => {
    const guest = targets({
      cfg: rolesConfig(),
      deviceId: "guest-device",
      userProfileId: "guest-profile",
      role: "guest",
    });

    expect(guest).toEqual([]);
  });

  it("still denies a revoked operator token", () => {
    const revoked = targets({
      cfg: rolesConfig(),
      deviceId: "revoked-device",
      userProfileId: GATEWAY_OWNER_PROFILE_ID,
      role: null,
      revokedAtMs: 1,
    });

    expect(revoked).toEqual([]);
  });

  it("still delivers to the owner when no roles are configured", () => {
    const owner = targets({
      cfg: {},
      deviceId: "owner-device",
      userProfileId: GATEWAY_OWNER_PROFILE_ID,
      role: null,
    });

    expect(owner.map((target) => target.subscription.subscriptionId)).toEqual([
      "subscription-owner-device",
    ]);
  });
});

describe("web push target client authority with gateway roles", () => {
  const pendingRecord = () => ({
    id: "approval-proof",
    request: {},
    createdAtMs: 1,
    expiresAtMs: Date.now() + 60_000,
  });

  it("mirrors the shared-secret owner connection for approval visibility", () => {
    const cfg = rolesConfig();
    const owner = targets({
      cfg,
      deviceId: "owner-device",
      userProfileId: GATEWAY_OWNER_PROFILE_ID,
      role: null,
    })[0];
    expect(owner).toBeDefined();
    if (!owner) {
      return;
    }

    const client = webPushTargetClient(owner);
    expect(client.internal?.operatorRoleActor).toEqual({ kind: "system" });
    expect(isApprovalRecordVisibleToClient({ record: pendingRecord(), client, cfg })).toBe(true);
  });

  it("leaves named-role targets on their derived operator actor", () => {
    const cfg = rolesConfig();
    const definitions = cfg.gateway?.roles?.definitions;
    if (!definitions) {
      throw new Error("roles config is missing definitions");
    }
    definitions.reviewer = {
      sessions: { others: "view" },
      agents: ["main"],
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    };
    const reviewer = targets({
      cfg,
      deviceId: "reviewer-device",
      userProfileId: "reviewer-profile",
      role: "reviewer",
    })[0];
    expect(reviewer).toBeDefined();
    if (!reviewer) {
      return;
    }

    const client = webPushTargetClient(reviewer);
    expect(client.internal?.operatorRoleActor).toBeUndefined();
    expect(isApprovalRecordVisibleToClient({ record: pendingRecord(), client, cfg })).toBe(true);
  });
});
