import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { mcpEnterpriseIdpStoreKey } from "../agents/mcp-enterprise.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStoreReadOnly } from "../agents/mcp-oauth-store.js";
import {
  countMcpOAuthPrincipals,
  readMcpOAuthCredentialsStatus,
  type McpOAuthPrincipalStatus,
} from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";

type McpStatusAuthStatusJson = McpOAuthPrincipalStatus & {
  hasTokens: boolean;
  requiresAuthorization: boolean;
  hasClientInformation: boolean;
  hasCodeVerifier: boolean;
  hasDiscoveryState: boolean;
  hasLastAuthorizationUrl: boolean;
};

type McpStatusEntry = {
  name: string;
  configured: true;
  enabled: boolean;
  ok: boolean;
  transport?: string;
  launch?: string;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  supportsParallelToolCalls?: boolean;
  auth?: unknown;
  authStatus?: McpStatusAuthStatusJson;
  connectedPrincipals?: number;
  toolFilter?: unknown;
  codex?: unknown;
};

export async function countConnectedMcpPrincipals(
  name: string,
  server: Record<string, unknown>,
): Promise<number | undefined> {
  const resolved = resolveMcpTransportConfig(name, server);
  if (
    server.auth !== "oauth" ||
    resolved?.kind !== "http" ||
    asRecord(server.oauth)?.identity !== "per-requester"
  ) {
    return undefined;
  }
  return countMcpOAuthPrincipals(operatorMcpOAuthIdentity(name, resolved.url));
}

export async function buildMcpStatusEntries(
  servers: Record<string, Record<string, unknown>>,
): Promise<McpStatusEntry[]> {
  const entries = Object.entries(servers).toSorted(([a], [b]) => a.localeCompare(b));
  return Promise.all(
    entries.map(async ([name, server]) => {
      const resolved = resolveMcpTransportConfig(name, server);
      const enabled = server.enabled !== false;
      const entry: McpStatusEntry = {
        name,
        configured: true,
        enabled,
        ok: enabled && Boolean(resolved),
        transport: resolved?.transportType,
        launch: resolved?.description,
        requestTimeoutMs: resolved?.requestTimeoutMs,
        connectionTimeoutMs: resolved?.connectionTimeoutMs,
        supportsParallelToolCalls: resolved?.supportsParallelToolCalls,
        toolFilter: server.toolFilter,
        codex: server.codex,
      };
      if (server.auth) {
        entry.auth = server.auth;
      }
      if (
        server.auth === "oauth" &&
        resolved?.kind === "http" &&
        asRecord(server.oauth)?.identity !== "per-requester"
      ) {
        const identity = operatorMcpOAuthIdentity(name, resolved.url);
        // Documented `mcp status --json` contract: the six legacy authStatus
        // booleans stay for existing scripts; `state` is the additive shape.
        const store = await readMcpOAuthStoreReadOnly(identity.storeKey);
        entry.authStatus = {
          hasTokens: Boolean(store.tokens),
          requiresAuthorization:
            store.pendingAuthorizationChallenge?.requiresAuthorization === true,
          hasClientInformation: Boolean(store.clientInformation),
          hasCodeVerifier: Boolean(store.codeVerifier),
          hasDiscoveryState: Boolean(store.discoveryState),
          hasLastAuthorizationUrl: Boolean(store.lastAuthorizationUrl),
          ...(await readMcpOAuthCredentialsStatus(identity, store)),
        };
      } else if (server.auth === "enterprise" && resolved?.kind === "http" && resolved.enterprise) {
        const store = await readMcpOAuthStoreReadOnly(
          mcpEnterpriseIdpStoreKey(resolved.enterprise),
        );
        const authorized = Boolean(
          store.tokens?.id_token &&
          (store.tokens.refresh_token ||
            (store.tokenExpiresAt && store.tokenExpiresAt > Date.now())),
        );
        entry.authStatus = {
          hasTokens: Boolean(store.tokens?.id_token),
          requiresAuthorization: !authorized,
          hasClientInformation: false,
          hasCodeVerifier: false,
          hasDiscoveryState: false,
          hasLastAuthorizationUrl: false,
          state: authorized ? "authorized" : "requires-authorization",
          ...(store.tokenExpiresAt ? { expiresAt: store.tokenExpiresAt } : {}),
        };
      } else {
        entry.connectedPrincipals = await countConnectedMcpPrincipals(name, server);
      }
      return entry;
    }),
  );
}
