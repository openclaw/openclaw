import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { formatRemainingShort } from "../../agents/auth-health.js";
import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles/paths.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles/store.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
} from "../../agents/auth-profiles/types.js";
import { resolveProfileUnusableUntilForDisplay } from "../../agents/auth-profiles/usage.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { shortenHomePath } from "../../utils.js";
import { loadValidConfigOrThrow, resolveKnownAgentId } from "./shared.js";

export type AuthListProfileRow = {
  id: string;
  provider: string;
  type: AuthProfileCredential["type"];
  account: string | null;
  credential: "api-key" | "api-key-ref" | "token" | "token-ref" | "oauth" | "missing";
  status: string;
  expiresAt: number | null;
};

export type AuthListResult = {
  agentId: string;
  agentDir: string;
  storePath: string;
  profiles: AuthListProfileRow[];
};

function resolveCredentialKind(profile: AuthProfileCredential): AuthListProfileRow["credential"] {
  if (profile.type === "api_key") {
    if (profile.keyRef) {
      return "api-key-ref";
    }
    return profile.key ? "api-key" : "missing";
  }
  if (profile.type === "token") {
    if (profile.tokenRef) {
      return "token-ref";
    }
    return profile.token ? "token" : "missing";
  }
  return profile.access ? "oauth" : "missing";
}

function resolveProfileExpiresAt(profile: AuthProfileCredential): number | null {
  if (profile.type === "api_key") {
    return null;
  }
  return typeof profile.expires === "number" ? profile.expires : null;
}

function resolveProfileStatus(params: {
  store: AuthProfileStore;
  profileId: string;
  profile: AuthProfileCredential;
  credential: AuthListProfileRow["credential"];
  nowMs: number;
}): string {
  const unusableUntil = resolveProfileUnusableUntilForDisplay(params.store, params.profileId);
  if (unusableUntil && params.nowMs < unusableUntil) {
    const stats = params.store.usageStats?.[params.profileId];
    const kind =
      typeof stats?.disabledUntil === "number" && params.nowMs < stats.disabledUntil
        ? "disabled"
        : "cooldown";
    return `${kind} ${formatRemainingShort(unusableUntil - params.nowMs)}`;
  }
  if (params.credential === "missing") {
    return "missing";
  }
  const expiresAt = resolveProfileExpiresAt(params.profile);
  if (!expiresAt) {
    return "ok";
  }
  if (expiresAt <= params.nowMs) {
    return "expired";
  }
  return `expires in ${formatRemainingShort(expiresAt - params.nowMs)}`;
}

export function buildAuthListProfileRows(
  store: AuthProfileStore,
  nowMs = Date.now(),
): AuthListProfileRow[] {
  return Object.entries(store.profiles)
    .map(([profileId, profile]) => {
      const credential = resolveCredentialKind(profile);
      return {
        id: profileId,
        provider: profile.provider,
        type: profile.type,
        account:
          normalizeOptionalString(profile.email) ??
          normalizeOptionalString(profile.displayName) ??
          null,
        credential,
        status: resolveProfileStatus({
          store,
          profileId,
          profile,
          credential,
          nowMs,
        }),
        expiresAt: resolveProfileExpiresAt(profile),
      };
    })
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export function formatAuthListText(result: AuthListResult): string {
  const lines = [
    `Agent: ${result.agentId}`,
    `Auth store: ${shortenHomePath(result.storePath)}`,
    "",
  ];

  if (result.profiles.length === 0) {
    lines.push("No auth profiles found.");
    return lines.join("\n");
  }

  const headers = ["Profile", "Provider", "Type", "Credential", "Account", "Status"];
  const rows = result.profiles.map((profile) => [
    profile.id,
    profile.provider,
    profile.type,
    profile.credential,
    profile.account ?? "-",
    profile.status,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  lines.push(headers.map((header, index) => pad(header, widths[index] ?? header.length)).join("  "));
  lines.push(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    lines.push(row.map((value, index) => pad(value, widths[index] ?? value.length)).join("  "));
  }
  return lines.join("\n");
}

export async function modelsAuthListCommand(
  opts: {
    agent?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const cfg = await loadValidConfigOrThrow();
  const agentId =
    resolveKnownAgentId({ cfg, rawAgentId: opts.agent }) ?? resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
  const result: AuthListResult = {
    agentId,
    agentDir,
    storePath: resolveAuthStorePathForDisplay(agentDir),
    profiles: buildAuthListProfileRows(store),
  };

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  if (opts.plain) {
    for (const profile of result.profiles) {
      runtime.log(profile.id);
    }
    return;
  }
  runtime.log(formatAuthListText(result));
}
