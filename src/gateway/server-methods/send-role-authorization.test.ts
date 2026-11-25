import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { linkOpenClawIdUserProfile } from "../../state/user-profile-openclaw-id.worker.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  type OpenClawIdTunnelPrincipal,
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdMemberAccountLookup,
} from "../openclaw-id/tunnel-principal.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { authorizeMessageActionSendAgent } from "./send-role-authorization.js";

afterEach(() => {
  setOpenClawIdTunnelPrincipalLookup(undefined);
  setOpenClawIdMemberAccountLookup(undefined);
  clearRuntimeConfigSnapshot();
});

it.each([undefined, "operator"])(
  "enforces the canonical profile agent ceiling with named-role default %s",
  async (defaultRole) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const profile = ensureProfileForEmail("send-member@example.test");
      setUserProfileRole(profile.id, "operator");
      linkOpenClawIdUserProfile({ profileId: profile.id, accountId: "member", email: null }, {});
      setOpenClawIdMemberAccountLookup((accountId) => accountId === "member");
      const role: GatewayOperatorRoleDefinition = {
        scopes: ["operator.write"],
        agents: [],
        sessions: { others: "none" },
      };
      const cfg: OpenClawConfig = {
        gateway: {
          openclawId: { enabled: true },
          roles: {
            default: defaultRole,
            definitions: { operator: role },
          },
        },
      };
      const principal: OpenClawIdTunnelPrincipal = {
        kind: "member",
        peerKey: "iroh:member",
        accountId: "member",
        role: "untrusted-membership-label",
      };
      setRuntimeConfigSnapshot(cfg);
      setOpenClawIdTunnelPrincipalLookup(() => principal);
      const client = {
        connect: gatewayConnect(["operator.write"]),
        authenticatedUserProfile: gatewayProfile(profile.id),
        internal: { openclawIdPrincipal: principal },
      };
      for (const agentId of [undefined, "main"]) {
        expect(authorizeMessageActionSendAgent({ cfg, client, agentId })).toMatchObject({
          code: "FORBIDDEN",
        });
      }
      role.agents = ["main"];
      expect(authorizeMessageActionSendAgent({ cfg, client, agentId: "main" })).toBeUndefined();
    });
  },
);

it.each(["local", "owner", "member"] as const)(
  "keeps unrestricted %s sends independent of implicit agent selection",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const profile = ensureProfileForEmail("send-unrestricted@example.test");
      setUserProfileRole(profile.id, "operator");
      const cfg: OpenClawConfig = {
        agents: { entries: { first: {}, second: {} } },
        gateway: {
          roles: {
            default: "operator",
            definitions: {
              operator: { scopes: ["operator.write"], agents: "*", sessions: { others: "none" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const principal: OpenClawIdTunnelPrincipal =
        kind === "member"
          ? { kind, peerKey: "iroh:member", accountId: "member", role: "operator" }
          : { kind: "owner", peerKey: "iroh:owner" };
      setOpenClawIdTunnelPrincipalLookup(() => principal);
      const client = {
        connect: gatewayConnect(["operator.write"]),
        authenticatedUserProfile: gatewayProfile(profile.id),
        ...(kind === "local" ? {} : { internal: { openclawIdPrincipal: principal } }),
      };
      expect(authorizeMessageActionSendAgent({ cfg, client })).toBeUndefined();
    });
  },
);
