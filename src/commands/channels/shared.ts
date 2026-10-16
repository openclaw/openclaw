import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import { getChannelsCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import { requireValidConfig } from "../config-validation.js";

export type ChatChannel = ChannelId;

export const NO_CONFIGURED_CHAT_CHANNELS_LINE =
  "- no configured chat channels (run `openclaw channels list --all` to see installable channels)";

export { requireValidConfigForWrite } from "../config-validation.js";

/** Load valid channel command config with read-only secret resolution applied. */
export async function requireValidChannelConfig(
  runtime: RuntimeEnv,
): Promise<OpenClawConfig | null> {
  const cfg = await requireValidConfig(runtime, { skipPluginValidation: true });
  if (!cfg) {
    return null;
  }
  const { effectiveConfig } = await resolveCommandConfigWithSecrets({
    config: cfg,
    commandName: "channels",
    targetIds: getChannelsCommandSecretTargetIds(),
    runtime,
  });
  return effectiveConfig;
}

export function formatChannelAccountLabel(params: {
  channel: ChatChannel;
  accountId: string;
  name?: string;
  channelLabel?: string;
  channelStyle?: (value: string) => string;
  accountStyle?: (value: string) => string;
}): string {
  const channelText = sanitizeTerminalText(params.channelLabel ?? params.channel);
  const accountId = sanitizeTerminalText(params.accountId || DEFAULT_ACCOUNT_ID);
  const name = params.name?.trim();
  const accountText = name ? `${accountId} (${sanitizeTerminalText(name)})` : accountId;
  const styledChannel = params.channelStyle ? params.channelStyle(channelText) : channelText;
  const styledAccount = params.accountStyle ? params.accountStyle(accountText) : accountText;
  return `${styledChannel} ${styledAccount}`;
}

/** Append canonical state fragments and genuine runtime failures for account output. */
export function appendEnabledConfiguredLinkedBits(
  bits: string[],
  account: Record<string, unknown>,
) {
  if (typeof account.enabled === "boolean") {
    bits.push(account.enabled ? "enabled" : "disabled");
  }
  if (typeof account.configured === "boolean") {
    if (account.configured) {
      bits.push("configured");
      if (hasConfiguredUnavailableCredentialStatus(account)) {
        bits.push("secret unavailable in this command path");
      }
    } else {
      bits.push("not configured");
    }
  }
  if (typeof account.linked === "boolean") {
    bits.push(account.linked ? "linked" : "not linked");
  }
  const reason = typeof account.stateReason === "string" ? account.stateReason : "";
  const duplicatesState =
    (account.enabled === false && reason === "disabled") ||
    (account.configured === false && reason === "not configured") ||
    (account.linked === false && reason === "not linked");
  if (reason && !duplicatesState) {
    bits.push(`reason:${reason}`);
  }
  const error = typeof account.lastError === "string" ? account.lastError : "";
  if (error) {
    bits.push(`error:${error}`);
  }
}

export function appendModeBit(bits: string[], account: Record<string, unknown>) {
  if (typeof account.mode === "string" && account.mode.length > 0) {
    bits.push(`mode:${account.mode}`);
  }
}

/** Append credential source fragments, preserving unavailable-secret state. */
export function appendTokenSourceBits(bits: string[], account: Record<string, unknown>) {
  const appendSourceBit = (label: string, sourceKey: string, statusKey: string) => {
    const source = account[sourceKey];
    if (typeof source !== "string" || !source || source === "none") {
      return;
    }
    const status = account[statusKey];
    const unavailable = status === "configured_unavailable" ? " (unavailable)" : "";
    bits.push(`${label}:${source}${unavailable}`);
  };

  appendSourceBit("token", "tokenSource", "tokenStatus");
  appendSourceBit("bot", "botTokenSource", "botTokenStatus");
  appendSourceBit("app", "appTokenSource", "appTokenStatus");
  appendSourceBit("signing", "signingSecretSource", "signingSecretStatus");
}

export function appendBaseUrlBit(bits: string[], account: Record<string, unknown>) {
  if (typeof account.baseUrl === "string" && account.baseUrl) {
    bits.push(`url:${account.baseUrl}`);
  }
}

export function buildChannelAccountLine(
  provider: ChatChannel,
  account: Record<string, unknown>,
  bits: string[],
  opts?: { channelLabel?: string },
): string {
  const accountId = typeof account.accountId === "string" ? account.accountId : DEFAULT_ACCOUNT_ID;
  const name = typeof account.name === "string" ? account.name : undefined;
  const labelText = formatChannelAccountLabel({
    channel: provider,
    accountId,
    name,
    channelLabel: opts?.channelLabel,
  });
  return `- ${labelText}: ${bits.join(", ")}`;
}
