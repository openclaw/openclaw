import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const accessOrigin = "https://team.cloudflareaccess.com";
export const accountIdClaim = "https://openclaw.ai/github-account-id";
const oidcProviderId = "verified-oidc-provider";
export const cfg: OpenClawConfig = {
  gateway: {
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
      },
    },
    roles: {
      default: "guest",
      definitions: {
        maintainer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.admin"] },
        guest: { sessions: { others: "none" }, agents: [], scopes: [] },
      },
    },
  },
};

export const githubCfg: OpenClawConfig = {
  gateway: {
    ...cfg.gateway,
    auth: {
      ...cfg.gateway?.auth,
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
        cloudflareAccessOidc: {
          issuer: accessOrigin,
          providerId: oidcProviderId,
          githubAccountIdClaim: accountIdClaim,
        },
      },
    },
  },
};

export function accessRequest(principal = "ada@example.test", config = cfg, issuer = accessOrigin) {
  setRuntimeConfigSnapshot(config);
  const req = new IncomingMessage(new Socket());
  req.headers = {
    "cf-access-authenticated-user-email": principal,
    "cf-access-jwt-assertion": `header.${Buffer.from(JSON.stringify({ iss: issuer })).toString("base64url")}.signature`,
  };
  const authResult = { ok: true, method: "trusted-proxy" as const, user: principal };
  return { req, authResult, cfg: config };
}

export function identityResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

export function oidcIdentity(
  claim: unknown = "101",
  field: "oidc_fields" | "custom" = "oidc_fields",
) {
  return {
    id: "unrelated-oidc-subject",
    email: "ada@example.test",
    idp: { type: "oidc", id: oidcProviderId },
    [field]: { "https://openclaw.ai/github-role": "none", [accountIdClaim]: claim },
  };
}
