// Target preparation shared by normal routing and authority-scoped V2 reads.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChannelId,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { enforceCrossContextPolicy } from "./outbound-policy.js";
import { invalidMessageActionTargetError } from "./target-errors.js";
import {
  assertTargetResolutionCurrent,
  targetResolutionAuthority,
} from "./target-resolution-authority.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";

async function resolveActionTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
  plugin?: ChannelPlugin;
}): Promise<ResolvedMessagingTarget | undefined> {
  let resolvedTarget: ResolvedMessagingTarget | undefined;
  const toRaw = normalizeOptionalString(params.args.to) ?? "";
  if (toRaw) {
    const resolved = await resolveResolvedTargetOrThrow({
      cfg: params.cfg,
      channel: params.channel,
      input: toRaw,
      accountId: params.accountId ?? undefined,
      plugin: params.plugin,
    });
    assertTargetResolutionCurrent();
    params.args.to = resolved.to;
    resolvedTarget = resolved;
  }
  const channelIdRaw = normalizeOptionalString(params.args.channelId) ?? "";
  if (channelIdRaw) {
    const resolved = await resolveResolvedTargetOrThrow({
      cfg: params.cfg,
      channel: params.channel,
      input: channelIdRaw,
      accountId: params.accountId ?? undefined,
      plugin: params.plugin,
      preferredKind: "group",
      validateResolvedTarget: (target) =>
        target.kind === "user"
          ? `Channel id "${channelIdRaw}" resolved to a user target.`
          : undefined,
    });
    assertTargetResolutionCurrent();
    params.args.channelId = sanitizeGroupTargetId(resolved.to);
  }
  return resolvedTarget;
}

function sanitizeGroupTargetId(target: string): string {
  return target.replace(/^(channel|group):/i, "");
}

async function resolveResolvedTargetOrThrow(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string;
  plugin?: ChannelPlugin;
  preferredKind?: "group" | "user" | "channel";
  validateResolvedTarget?: (target: ResolvedMessagingTarget) => string | undefined;
}): Promise<ResolvedMessagingTarget> {
  const resolved = await resolveChannelTarget({
    cfg: params.cfg,
    channel: params.channel,
    input: params.input,
    accountId: params.accountId,
    preferredKind: params.preferredKind,
    plugin: params.plugin,
  });
  if (!resolved.ok) {
    throw resolved.error;
  }
  const validationError = params.validateResolvedTarget?.(resolved.target);
  if (validationError) {
    throw invalidMessageActionTargetError(validationError);
  }
  return resolved.target;
}

export async function resolveMessageTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
  agentId?: string | null;
  deferExternalTargetResolution?: boolean;
  plugin?: ChannelPlugin;
}): Promise<ResolvedMessagingTarget | undefined> {
  const resolvedTarget = params.deferExternalTargetResolution
    ? undefined
    : await resolveActionTarget({
        cfg: params.cfg,
        channel: params.channel,
        action: params.action,
        args: params.args,
        accountId: params.accountId,
        plugin: params.plugin,
      });

  enforceCrossContextPolicy({
    channel: params.channel,
    action: params.action,
    args: params.args,
    toolContext: params.toolContext,
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return resolvedTarget;
}

/** Host-created V2 callback implementation; invoked within the provider request scope. */
export async function prepareConversationReadTarget(
  ctx: ChannelMessageActionContext,
  plugin: ChannelPlugin,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  await targetResolutionAuthority.run(assertCurrent, () =>
    resolveMessageTarget({
      cfg: ctx.cfg,
      channel: ctx.channel,
      action: ctx.action,
      args: ctx.params,
      accountId: ctx.accountId,
      toolContext: ctx.toolContext,
      agentId: ctx.agentId,
      plugin,
    }),
  );
  assertCurrent();
}
