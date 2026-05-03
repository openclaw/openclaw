import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshCostUsageCache } from "./session-cost-usage.js";

function parseConfig(): OpenClawConfig | undefined {
  const raw = process.env.OPENCLAW_USAGE_COST_CACHE_CONFIG;
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as OpenClawConfig) : undefined;
  } catch {
    return undefined;
  }
}

const agentId = process.env.OPENCLAW_USAGE_COST_CACHE_AGENT_ID?.trim() || undefined;
const maxFilesRaw = Number(process.env.OPENCLAW_USAGE_COST_CACHE_MAX_FILES);
const maxFiles =
  Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? Math.floor(maxFilesRaw) : undefined;

refreshCostUsageCache({ agentId, config: parseConfig(), maxFiles })
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    process.stderr.write(`usage-cost cache refresh failed: ${String(err)}\n`);
    process.exitCode = 1;
  });
