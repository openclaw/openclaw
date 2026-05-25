// Public usage fetch helpers for provider plugins.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { tryReadJsonSync } from "../infra/json-files.js";

export type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../infra/provider-usage.types.js";

export {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchGeminiUsage,
  fetchMinimaxUsage,
  fetchZaiUsage,
} from "../infra/provider-usage.fetch.js";
export { clampPercent, PROVIDER_LABELS } from "../infra/provider-usage.shared.js";
export {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
} from "../infra/provider-usage.fetch.shared.js";

/**
 * @deprecated Compatibility for external provider plugins that still bridge
 * credentials from the retired Pi auth store. Core OpenClaw runtime paths no
 * longer read this file; use auth profiles, config, or provider-owned auth.
 */
export function resolveLegacyAgentAccessToken(
  env: NodeJS.ProcessEnv,
  providerIds: string[],
): string | undefined {
  try {
    const authPath = path.join(
      resolveRequiredHomeDir(env, os.homedir),
      ".pi",
      "agent",
      "auth.json",
    );
    if (!fs.existsSync(authPath)) {
      return undefined;
    }
    const parsed = tryReadJsonSync<Record<string, { access?: string }>>(authPath);
    for (const providerId of providerIds) {
      const token = parsed?.[providerId]?.access;
      if (typeof token === "string" && token.trim()) {
        return token;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
