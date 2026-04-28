import { describe, expect, it } from "vitest";
import {
  canManageOpenAICodex,
  MCTL_OWNER_SCOPE,
  resolveTrustedProxyTeamRole,
} from "../../../openai-codex/connect-store.js";
import type { GatewayAuthResult } from "../../auth.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
} from "../../method-scopes.js";
import { buildTrustedProxyScopes } from "./message-handler.js";

function trustedProxyResult(role: string | null): GatewayAuthResult {
  return {
    ok: true,
    method: "trusted-proxy",
    user: "peter@example.com",
    role: role ?? undefined,
  } as GatewayAuthResult;
}

describe("trusted-proxy role → scope augmentation", () => {
  it("owner role grants the full mctl operator scope set including MCTL_OWNER_SCOPE", () => {
    const scopes = buildTrustedProxyScopes(trustedProxyResult("owner"));
    expect(scopes).toEqual(
      expect.arrayContaining([
        "mctl.role:owner",
        MCTL_OWNER_SCOPE,
        ADMIN_SCOPE,
        READ_SCOPE,
        WRITE_SCOPE,
        APPROVALS_SCOPE,
        PAIRING_SCOPE,
      ]),
    );
  });

  it("developer role grants read+write but not owner/admin/approvals/pairing", () => {
    const scopes = buildTrustedProxyScopes(trustedProxyResult("developer"));
    expect(scopes).toEqual(
      expect.arrayContaining(["mctl.role:developer", READ_SCOPE, WRITE_SCOPE]),
    );
    expect(scopes).not.toContain(MCTL_OWNER_SCOPE);
    expect(scopes).not.toContain(ADMIN_SCOPE);
    expect(scopes).not.toContain(APPROVALS_SCOPE);
    expect(scopes).not.toContain(PAIRING_SCOPE);
  });

  it("unknown role falls back to read-only access", () => {
    const scopes = buildTrustedProxyScopes(trustedProxyResult("guest"));
    expect(scopes).toEqual(["mctl.role:guest", READ_SCOPE]);
    expect(scopes).not.toContain(MCTL_OWNER_SCOPE);
    expect(scopes).not.toContain(WRITE_SCOPE);
  });

  it("missing role yields no augmentation", () => {
    expect(buildTrustedProxyScopes(trustedProxyResult(null))).toEqual([]);
    expect(buildTrustedProxyScopes(trustedProxyResult(""))).toEqual([]);
  });

  it("non-trusted-proxy auth result yields no augmentation", () => {
    const tokenAuth = { ok: true, method: "token" } as GatewayAuthResult;
    expect(buildTrustedProxyScopes(tokenAuth)).toEqual([]);
  });
});

describe("owner-augmented scopes propagate to codex.connect.status payload", () => {
  it("owner role makes codex manageable and surfaces teamRole=owner", () => {
    const scopes = buildTrustedProxyScopes(trustedProxyResult("owner"));
    const client = { connect: { scopes } };
    expect(canManageOpenAICodex(client)).toBe(true);
    expect(resolveTrustedProxyTeamRole(client)).toBe("owner");
  });

  it("developer role surfaces teamRole=developer but is not allowed to manage codex", () => {
    const scopes = buildTrustedProxyScopes(trustedProxyResult("developer"));
    const client = { connect: { scopes } };
    expect(canManageOpenAICodex(client)).toBe(false);
    expect(resolveTrustedProxyTeamRole(client)).toBe("developer");
  });

  it("missing role does not grant manage capability and surfaces null teamRole", () => {
    const client = { connect: { scopes: buildTrustedProxyScopes(trustedProxyResult(null)) } };
    expect(canManageOpenAICodex(client)).toBe(false);
    expect(resolveTrustedProxyTeamRole(client)).toBe(null);
  });
});
