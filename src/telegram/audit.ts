import type { TelegramGroupConfig } from "../config/types.js";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";

export type TelegramGroupMembershipAuditEntry = {
  chatId: string;
  ok: boolean;
  status?: string | null;
  error?: string | null;
  matchKey?: string;
  matchSource?: "id";
};

export type TelegramGroupMembershipAudit = {
  ok: boolean;
  checkedGroups: number;
  unresolvedGroups: number;
  hasWildcardUnmentionedGroups: boolean;
  groups: TelegramGroupMembershipAuditEntry[];
  elapsedMs: number;
};

export function collectTelegramUnmentionedGroupIds(
  groups: Record<string, TelegramGroupConfig> | undefined,
) {
  if (!groups || typeof groups !== "object") {
    return {
      groupIds: [] as string[],
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
    };
  }
  const hasWildcardUnmentionedGroups =
    Boolean(groups["*"]?.requireMention === false) && groups["*"]?.enabled !== false;
  const groupIds: string[] = [];
  let unresolvedGroups = 0;
  for (const [key, value] of Object.entries(groups)) {
    if (key === "*") {
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    if (value.enabled === false) {
      continue;
    }
    if (value.requireMention !== false) {
      continue;
    }
    const id = String(key).trim();
    if (!id) {
      continue;
    }
    if (/^-?\d+$/.test(id)) {
      groupIds.push(id);
    } else {
      unresolvedGroups += 1;
    }
  }
  groupIds.sort((a, b) => a.localeCompare(b));
  return { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups };
}

export type AuditTelegramGroupMembershipParams = {
  token: string;
  botId: number;
  groupIds: string[];
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
  timeoutMs: number;
};

let auditMembershipRuntimePromise: Promise<typeof import("./audit-membership-runtime.js")> | null =
  null;

function loadAuditMembershipRuntime() {
  auditMembershipRuntimePromise ??= import("./audit-membership-runtime.js");
  return auditMembershipRuntimePromise;
}

export async function auditTelegramGroupMembership(
  params: AuditTelegramGroupMembershipParams,
): Promise<TelegramGroupMembershipAudit> {
  const started = Date.now();
  const token = params.token?.trim() ?? "";
  if (!token || params.groupIds.length === 0) {
    return {
      ok: true,
      checkedGroups: 0,
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
      groups: [],
      elapsedMs: Date.now() - started,
    };
  }

  // Lazy import to avoid pulling `undici` (ProxyAgent) into cold-path callers that only need
  // `collectTelegramUnmentionedGroupIds` (e.g. config audits).
  const { auditTelegramGroupMembershipImpl } = await loadAuditMembershipRuntime();
  const result = await auditTelegramGroupMembershipImpl({
    ...params,
    token,
  });
  return {
    ...result,
    elapsedMs: Date.now() - started,
  };
}
