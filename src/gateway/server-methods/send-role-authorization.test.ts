import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type OpenClawIdTunnelPrincipal,
  setOpenClawIdTunnelPrincipalLookup,
} from "../openclaw-id/tunnel-principal.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { authorizeMessageActionSendAgent } from "./send-role-authorization.js";

afterEach(() => {
  setOpenClawIdTunnelPrincipalLookup(undefined);
  clearRuntimeConfigSnapshot();
});

it.each([undefined, "operator"])(
  "enforces the ID member agent ceiling with named-role default %s",
  (defaultRole) => {
    const role: GatewayOperatorRoleDefinition = {
      scopes: ["operator.write"],
      agents: [],
      sessions: { others: "none" },
    };
    const cfg: OpenClawConfig = {
      gateway: {
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
      role: "operator",
    };
    setRuntimeConfigSnapshot(cfg);
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    const client = {
      connect: gatewayConnect(["operator.write"]),
      internal: { openclawIdPrincipal: principal },
    };
    for (const agentId of [undefined, "main"]) {
      expect(authorizeMessageActionSendAgent({ cfg, client, agentId })).toMatchObject({
        code: "FORBIDDEN",
      });
    }
    role.agents = ["main"];
    expect(authorizeMessageActionSendAgent({ cfg, client, agentId: "main" })).toBeUndefined();
  },
);

it.each(["local", "owner", "member"] as const)(
  "keeps unrestricted %s sends independent of implicit agent selection",
  (kind) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { first: {}, second: {} } },
      gateway: {
        roles: {
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
    const client =
      kind === "local"
        ? null
        : {
            connect: gatewayConnect(["operator.write"]),
            internal: { openclawIdPrincipal: principal },
          };
    expect(authorizeMessageActionSendAgent({ cfg, client })).toBeUndefined();
  },
);
