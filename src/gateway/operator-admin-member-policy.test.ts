import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { MEMBER_ROLE_PRESETS } from "./openclaw-id/member-role-presets.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { resolveAdministratorMemberRolePolicy } from "./operator-role-policy.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";

afterEach(() => {
  setOpenClawIdTunnelPrincipalLookup(undefined);
  clearRuntimeConfigSnapshot();
});

it("overrides profile policy only for current administrator members", () => {
  const definitions = {
    ...MEMBER_ROLE_PRESETS,
    admin: {
      scopes: ["operator.admin" as const],
      agents: "*" as const,
      sessions: { others: "write" as const },
    },
  };
  const cfg = { gateway: { roles: { definitions, default: "viewer" } } };
  setRuntimeConfigSnapshot(cfg);
  for (const principal of [
    undefined,
    { kind: "owner", peerKey: "owner" },
    { kind: "node", peerKey: "node" },
    { kind: "member", peerKey: "member", accountId: "member", role: "operator" },
    { kind: "member", peerKey: "admin", accountId: "admin", role: "admin" },
  ] satisfies Array<OpenClawIdTunnelPrincipal | undefined>) {
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    for (const scopes of [["operator.write"], ["operator.admin"]]) {
      const client = {
        connect: gatewayConnect(scopes),
        internal: { openclawIdPrincipal: principal },
      };
      const policy = resolveAdministratorMemberRolePolicy(client, cfg);
      if (principal?.kind !== "member" || !scopes.includes("operator.admin")) {
        expect(policy).toBeUndefined();
      } else if (principal.role === "admin") {
        expect(policy).toEqual(definitions.admin);
        setOpenClawIdTunnelPrincipalLookup(() => undefined);
        expect(() => resolveAdministratorMemberRolePolicy(client, cfg)).toThrow(
          "membership authority changed",
        );
      } else {
        expect(policy?.scopes).toEqual([]);
      }
    }
  }
});
