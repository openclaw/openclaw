import type { OperatorRunRecoverySnapshot } from "../operator-run-recovery-source.codec.js";
import type { LegacyOpenClawIdMemberRoleImport } from "./member-source-role-import.js";

export const memberRoleImport: LegacyOpenClawIdMemberRoleImport = {
  profileId: "member-profile",
  accountId: "member-account",
  role: "operator",
  policy: {
    sessions: { others: "invited" },
    agents: ["main"],
    scopes: ["operator.write"],
    workerProfiles: ["bounded-worker"],
    sandbox: "required",
  },
};

export function legacyMemberSnapshot(): OperatorRunRecoverySnapshot {
  return {
    profileId: memberRoleImport.profileId,
    openclawIdPrincipal: {
      kind: "member",
      accountId: memberRoleImport.accountId,
      role: memberRoleImport.role,
      peerKey: `iroh:${"a".repeat(64)}`,
      authority: { clawId: "claw", rootPub: "root", listedSeq: 7 },
    },
    scopes: ["operator.read", "operator.write"],
    assignedRole: null,
    githubLogin: "synthetic-member",
    rolePolicy: structuredClone(memberRoleImport.policy),
    modelPolicy: {
      models: [{ provider: "example", model: "bounded" }],
      allowed: { exact: ["example/bounded"], wildcards: [] },
      denied: { exact: [], wildcards: ["other/*"] },
    },
    grant: { pluginId: "policy", grantId: "retained" },
    aliasBindingIds: ["retained-alias"],
    authPolicy: {
      generation: "",
      grantGeneration: "retained-generation",
      role: "operator",
      authMethod: "trusted-proxy",
      verifiedIdentity: "member-account",
      browserOrigin: { openclawIdTunnel: true },
    },
    device: { deviceId: "retained-device", key: "b".repeat(64) },
    controlUiAdmin: false,
    localOperator: false,
    sourceIngress: "control-ui",
  };
}
