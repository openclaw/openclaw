import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { inspectChannelAccount } from "../../channels/account-inspection.js";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import {
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../../channels/account-summary.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { asBoolean } from "../../utils/boolean.js";

const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";

export function buildNonSensitiveProbeFailure(
  channelId: string,
  probe: unknown,
): Record<string, unknown> | undefined {
  const record = asNullableRecord(probe);
  if (channelId !== "imessage" || !record || record.ok !== false) {
    return undefined;
  }
  if (typeof record.error !== "string") {
    return undefined;
  }

  // Preserve the actionable Full Disk Access failure while stripping the local
  // username path before health leaves the gateway.
  const error = record.error
    .trim()
    .replaceAll(/\/Users\/[^/\s]+\/Library\/Messages\/chat\.db/g, "~/Library/Messages/chat.db");
  if (
    !/\bimsg\b/i.test(error) ||
    !error.includes("~/Library/Messages/chat.db") ||
    !/\bFull Disk Access\b/i.test(error)
  ) {
    return undefined;
  }
  return { ok: false, error: PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR };
}

export async function resolveHealthAccountContext(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<{
  probeAccount: unknown;
  inspectedAccount: unknown;
  enabled: boolean;
  configured: boolean | undefined;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  let inspectedAccount: unknown;
  try {
    inspectedAccount = await inspectChannelAccount(params);
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to inspect account (${formatErrorMessage(error)}).`,
    );
  }

  const inspected = asNullableRecord(inspectedAccount);
  const inspectedEnabled = asBoolean(inspected?.enabled);
  const inspectedConfigured = asBoolean(inspected?.configured);
  let account: unknown;
  if (inspectedEnabled !== false && !hasConfiguredUnavailableCredentialStatus(inspectedAccount)) {
    try {
      account = await resolveChannelAccount(params);
    } catch (error) {
      diagnostics.push(
        `${params.plugin.id}:${params.accountId}: failed to resolve account (${formatErrorMessage(error)}).`,
      );
    }
  }

  if (account === null || account === undefined) {
    return {
      probeAccount: undefined,
      inspectedAccount,
      enabled: inspectedEnabled ?? false,
      configured: inspectedConfigured,
      diagnostics,
    };
  }

  let enabled = asBoolean(asNullableRecord(account)?.enabled) ?? true;
  try {
    enabled = resolveChannelAccountEnabled({ plugin: params.plugin, account, cfg: params.cfg });
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`,
    );
  }
  let configured = asBoolean(asNullableRecord(account)?.configured) ?? true;
  try {
    configured = await resolveChannelAccountConfigured({
      plugin: params.plugin,
      account,
      cfg: params.cfg,
      readAccountConfiguredField: true,
    });
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`,
    );
  }

  return {
    probeAccount: account,
    inspectedAccount,
    enabled,
    configured,
    diagnostics,
  };
}
