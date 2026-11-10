import { readFileSync, unwatchFile, watchFile } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isAbsolute } from "node:path";
import type { GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  isDelegatedUserSubject,
  type DelegatedUserIdentity,
} from "../state/user-profile-delegation.js";
import { getHeader } from "./http-header-value.js";

export const GATEWAY_DELEGATION_DENIED = "trusted_proxy_delegation_denied";

type CredentialOwner = { value?: string; generation: number; refresh: () => void };
const credentials = new Map<string, CredentialOwner>();

function credentialOwner(path: string): CredentialOwner {
  const existing = credentials.get(path);
  if (existing) {
    return existing;
  }
  const owner: CredentialOwner = {
    generation: 0,
    refresh: () => {
      owner.generation += 1;
      owner.value = undefined;
      try {
        const value = readFileSync(path, "utf8").replace(/\r?\n$/u, "");
        if (/^[0-9a-f]{64}$/u.test(value)) {
          owner.value = value;
        }
      } catch {
        // An unreadable or removed revision credential revokes its existing grants.
      }
    },
  };
  owner.refresh();
  // Projected Kubernetes secrets replace symlinks; watchFile follows those swaps.
  // Request authorization only consumes this owner's memory, never the filesystem.
  watchFile(path, { interval: 1000, persistent: false }, owner.refresh);
  credentials.set(path, owner);
  return owner;
}

export function disposeGatewayDelegationCredentials(): void {
  for (const [path, owner] of credentials) {
    owner.generation += 1;
    owner.value = undefined;
    unwatchFile(path, owner.refresh);
  }
  credentials.clear();
}

export type GatewayDelegation = Readonly<{
  identity: DelegatedUserIdentity;
  scopes: readonly string[];
  credentialFile: string;
  isCurrent: () => boolean;
}>;

/** Reserved claims are terminal even when another native credential is valid. */
export function hasGatewayDelegationClaim(req?: IncomingMessage, userHeader?: string): boolean {
  return Boolean(
    req &&
    (getHeader(req, "x-occ-browser-key") !== undefined ||
      ["x-occ-identity", userHeader].some(
        (header) => header && getHeader(req, header)?.trim().startsWith("oce:"),
      )),
  );
}

export function authorizeGatewayDelegation(
  req: IncomingMessage,
  config: GatewayTrustedProxyConfig,
  user: string,
): GatewayDelegation | undefined {
  const delegation = config.delegation;
  const scope = getHeader(req, "x-openclaw-scopes");
  const key = getHeader(req, "x-occ-browser-key");
  if (
    !delegation ||
    delegation.authority !== "oce" ||
    delegation.subjectPrefix !== "oce:v1:" ||
    !isAbsolute(delegation.credentialFile) ||
    !isDelegatedUserSubject(user) ||
    (scope !== "operator.admin" && scope !== "operator.sessions.write") ||
    !key ||
    !/^[0-9a-f]{64}$/u.test(key)
  ) {
    return undefined;
  }
  const owner = credentialOwner(delegation.credentialFile);
  if (!owner.value || !safeEqualSecret(owner.value, key)) {
    return undefined;
  }
  const generation = owner.generation;
  return Object.freeze({
    identity: { authority: "oce" as const, subject: user },
    scopes: Object.freeze([scope]),
    credentialFile: delegation.credentialFile,
    isCurrent: () => owner.generation === generation && owner.value !== undefined,
  });
}

export function isGatewayDelegationCurrent(
  grant: GatewayDelegation,
  config: OpenClawConfig,
): boolean {
  const auth = config.gateway?.auth;
  const delegation = auth?.trustedProxy?.delegation;
  return (
    grant.isCurrent() &&
    auth?.mode === "trusted-proxy" &&
    delegation?.authority === grant.identity.authority &&
    delegation.subjectPrefix === "oce:v1:" &&
    delegation.credentialFile === grant.credentialFile
  );
}
