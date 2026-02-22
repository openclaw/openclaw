import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { fetchCodexUsage } from "../../infra/provider-usage.fetch.codex.js";
import type { UsageWindow } from "../../infra/provider-usage.types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { resolveKnownAgentId } from "./shared.js";

function resolveTargetAgent(
  cfg: ReturnType<typeof loadConfig>,
  raw?: string,
): {
  agentId: string;
  agentDir: string;
} {
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: raw }) ?? resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  return { agentId, agentDir };
}

interface AccountStatus {
  profileId: string;
  email?: string;
  accountId?: string;
  expires?: number;
  status: "active" | "expired" | "unknown";
  windows?: UsageWindow[];
}

function formatProgressBar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const filledBar = "█".repeat(filled);
  const emptyBar = "░".repeat(empty);
  return `[${filledBar}${emptyBar}]`;
}

function formatResetTime(resetAt?: number): string {
  if (!resetAt) {
    return "";
  }
  const date = new Date(resetAt);
  const now = new Date();
  const isToday = date.getDate() === now.getDate();

  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");

  if (isToday) {
    return `(resets ${hours}:${mins})`;
  }
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `(resets ${hours}:${mins} on ${month} ${day})`;
}

function formatExpiry(expires?: number): string {
  if (!expires) {
    return "unknown";
  }
  const now = Date.now();
  if (expires < now) {
    return "expired";
  }
  const left = expires - now;
  const hours = Math.floor(left / (1000 * 60 * 60));
  const mins = Math.floor((left % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h left`;
  }
  return `${hours}h ${mins}m left`;
}

export async function modelsAuthStatusCommand(
  opts: { provider: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) {
    throw new Error("Missing --provider.");
  }
  const provider = normalizeProviderId(rawProvider);

  const cfg = loadConfig();
  const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });

  const profiles = listProfilesForProvider(store, provider);
  const order = store.order?.[provider] ?? [];
  const accounts: AccountStatus[] = [];

  for (const profileId of profiles) {
    const cred = store.profiles[profileId];
    if (!cred || normalizeProviderId(cred.provider) !== provider) {
      continue;
    }

    const now = Date.now();
    const credExpires = "expires" in cred ? cred.expires : undefined;
    const credAccess = "access" in cred ? (cred.access as string | undefined) : undefined;
    const credAccountId = "accountId" in cred ? (cred.accountId as string | undefined) : undefined;
    const isExpired = credExpires && credExpires < now;
    let windows: UsageWindow[] | undefined;

    if (provider === "openai-codex" && cred.type === "oauth") {
      try {
        const usage = await fetchCodexUsage(credAccess ?? "", credAccountId, 5000, fetch);
        if (usage.windows && usage.windows.length > 0) {
          windows = usage.windows;
        }
      } catch {
        // ignore quota fetch errors
      }
    }

    accounts.push({
      profileId,
      email: cred.email,
      accountId: credAccountId,
      expires: credExpires,
      status: isExpired ? "expired" : credExpires ? "active" : "unknown",
      windows,
    });
  }

  const currentOrder = order.length > 0 ? order : accounts.map((a) => a.profileId);
  const results = currentOrder
    .map((profileId) => accounts.find((a) => a.profileId === profileId))
    .filter(Boolean) as AccountStatus[];

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          provider,
          authStorePath: shortenHomePath(`${agentDir}/auth-profiles.json`),
          accounts: results.map((a) => ({
            profileId: a.profileId,
            email: a.email,
            accountId: a.accountId,
            status: a.status,
            expires: a.expires ? new Date(a.expires).toISOString() : null,
            windows: a.windows,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`\n=== ${provider} Accounts ===\n`);
  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Auth file: ${shortenHomePath(`${agentDir}/auth-profiles.json`)}\n`);

  if (results.length === 0) {
    runtime.log("No accounts found.");
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const acc = results[i];
    const isCurrent = i === 0;
    const prefix = isCurrent ? "▶" : " ";
    const email = acc.email ?? acc.accountId ?? acc.profileId.split(":")[1] ?? "unknown";

    runtime.log(`${prefix} ${email}`);
    runtime.log(`  Profile: ${acc.profileId}`);
    runtime.log(`  Status: ${acc.status === "expired" ? "🔴 expired" : "🟢 active"}`);
    runtime.log(`  Token: ${formatExpiry(acc.expires)}`);

    if (acc.windows && acc.windows.length > 0) {
      for (const window of acc.windows) {
        const left = 100 - window.usedPercent;
        const bar = formatProgressBar(left);
        const resetStr = formatResetTime(window.resetAt);
        runtime.log(`  ${window.label} limit: ${bar} ${left.toFixed(0)}% left ${resetStr}`);
      }
    }
    runtime.log("");
  }

  runtime.log("Use --provider to check other providers.");
  runtime.log("Use 'openclaw models auth order set --provider <name> <profileIds...>' to reorder.");
}
