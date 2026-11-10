import { readFileSync, statSync } from "node:fs";
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

type CredentialOwner = { value?: string; generation: number; stop: () => void };
const credentials = new Map<string, CredentialOwner>();

function credentialOwner(path: string): CredentialOwner {
  const existing = credentials.get(path);
  if (existing) {
    return existing;
  }
  let revision: string | undefined;
  const owner: CredentialOwner = { generation: 0, stop: () => clearInterval(poll) };
  const refresh = () => {
    let nextRevision: string | undefined;
    let value: string | undefined;
    try {
      const stat = statSync(path, { bigint: true });
      nextRevision = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      const content = readFileSync(path, "utf8").replace(/\r?\n$/u, "");
      if (/^[0-9a-f]{64}$/u.test(content)) {
        value = content;
      }
    } catch {
      // An unreadable or removed revision credential revokes its existing grants.
    }
    if (revision !== nextRevision || owner.value !== value) {
      owner.generation += 1;
      owner.value = value;
      revision = nextRevision;
    }
  };
  // Snapshot before admission: watchFile's asynchronous initial stat can miss a
  // replacement immediately after the first grant. Polling follows projected
  // secret symlinks without putting filesystem reads on request paths.
  refresh();
  const poll = setInterval(refresh, 1000);
  poll.unref();
  credentials.set(path, owner);
  return owner;
}

export function disposeGatewayDelegationCredentials(): void {
  for (const owner of credentials.values()) {
    owner.generation += 1;
    owner.value = undefined;
    owner.stop();
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
