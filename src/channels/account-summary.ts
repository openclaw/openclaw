import type { OpenClawConfig } from "../config/config.js";
import { projectSafeChannelAccountSnapshotFields } from "./account-snapshot-fields.js";
import type { ChannelAccountSnapshot } from "./plugins/types.core.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";

export function buildChannelAccountSnapshot(params: {
  plugin: ChannelPlugin;
  account: unknown;
  cfg: OpenClawConfig;
  accountId: string;
  enabled: boolean;
  configured: boolean;
}): ChannelAccountSnapshot {
  const described = params.plugin.config.describeAccount?.(params.account, params.cfg);
  return {
    enabled: params.enabled,
    configured: params.configured,
    ...projectSafeChannelAccountSnapshotFields(params.account),
    ...described,
    accountId: params.accountId,
  };
}

export function formatChannelAllowFrom(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}): string[] {
  if (params.plugin.config.formatAllowFrom) {
    return params.plugin.config.formatAllowFrom({
      cfg: params.cfg,
      accountId: params.accountId,
      allowFrom: params.allowFrom,
    });
  }
  return params.allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function resolveChannelAccountEnabled(params: {
  plugin: ChannelPlugin;
  account: unknown;
  cfg: OpenClawConfig;
}): boolean {
  if (params.plugin.config.isEnabled) {
    return params.plugin.config.isEnabled(params.account, params.cfg);
  }
  const enabled = asRecord(params.account)?.enabled;
  return enabled !== false;
}

export async function resolveChannelAccountConfigured(params: {
  plugin: ChannelPlugin;
  account: unknown;
  cfg: OpenClawConfig;
  readAccountConfiguredField?: boolean;
}): Promise<boolean> {
  if (params.plugin.config.isConfigured) {
    return await params.plugin.config.isConfigured(params.account, params.cfg);
  }
  if (params.readAccountConfiguredField) {
    const configured = asRecord(params.account)?.configured;
    return configured !== false;
  }
  return true;
}
