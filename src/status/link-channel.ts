// Resolves the first channel that can report linked/unlinked auth state for status summaries.
// Channel-specific linking logic stays inside plugin status hooks.

import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveInspectedChannelAccount } from "../channels/account-inspection.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Returns link status for the first configured read-only channel that exposes linked state. */
export async function resolveLinkChannelContext(
  cfg: OpenClawConfig,
  options: { sourceConfig?: OpenClawConfig } = {},
) {
  const sourceConfig = options.sourceConfig ?? cfg;
  for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, {
    activationSourceConfig: sourceConfig,
    includeSetupFallbackPlugins: false,
  })) {
    const defaultAccountId = resolveChannelDefaultAccountId({ plugin, cfg });
    const context = await resolveInspectedChannelAccount({
      plugin,
      cfg,
      sourceConfig,
      accountId: defaultAccountId,
    });
    if (context.kind === "unavailable") {
      continue;
    }
    const { account, snapshot } = context;
    const summary =
      context.kind === "resolved" && plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account,
            cfg,
            defaultAccountId,
            snapshot,
          })
        : snapshot;
    const summaryRecord = asNullableRecord(summary);
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
    if (linked === null) {
      // Keep scanning until a plugin reports an explicit linked/unlinked value.
      continue;
    }
    const authAgeMs =
      summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
    return { linked, authAgeMs, account, accountId: defaultAccountId, plugin };
  }
  return null;
}
