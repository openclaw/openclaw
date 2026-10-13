import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import {
  getLoadedChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalAdapter,
} from "../../channels/plugins/index.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import { dedupeByKey } from "../../shared/dedupe-by-key.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { routeReply } from "./route-reply.js";

export type PrivateCommandRouteTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

const PRIVATE_COMMAND_APPROVAL_ROUTE_TTL_MS = 5 * 60_000;
const EXPIRED_PRIVATE_COMMAND_APPROVAL_ROUTE_EXPIRES_AT_MS = 0;

/** Finds private owner DM routes that can receive sensitive command replies. */
export async function resolvePrivateCommandRouteTargets(params: {
  commandParams: HandleCommandsParams;
  id: string;
  command: string;
  commandArgv?: string[];
}): Promise<PrivateCommandRouteTarget[]> {
  const { commandParams } = params;
  const createdAtMs = Date.now();
  const request: ExecApprovalRequest = {
    approvalKind: "exec",
    id: params.id,
    request: {
      command: params.command,
      ...(params.commandArgv === undefined ? {} : { commandArgv: params.commandArgv }),
      agentId: commandParams.agentId,
      ...(commandParams.sessionKey ? { sessionKey: commandParams.sessionKey } : {}),
      turnSourceChannel: commandParams.command.channel,
      turnSourceTo: readCommandDeliveryTarget(commandParams) ?? null,
      turnSourceAccountId: commandParams.ctx.AccountId ?? null,
      turnSourceThreadId: readCommandMessageThreadId(commandParams) ?? null,
    },
    createdAtMs,
    expiresAtMs:
      resolveExpiresAtMsFromDurationMs(PRIVATE_COMMAND_APPROVAL_ROUTE_TTL_MS, {
        nowMs: createdAtMs,
      }) ?? EXPIRED_PRIVATE_COMMAND_APPROVAL_ROUTE_EXPIRES_AT_MS,
  };
  const originChannel = params.commandParams.command.channel;
  const targets: PrivateCommandRouteTarget[] = [];
  for (const candidate of listPrivateCommandRouteCandidateChannels(originChannel)) {
    const adapter = resolveChannelApprovalAdapter(candidate.plugin);
    const native = adapter?.nativeAsync ?? adapter?.native;
    if (!native?.resolveApproverDmTargets) {
      continue;
    }
    const accountId =
      candidate.channel === originChannel
        ? (params.commandParams.ctx.AccountId ?? undefined)
        : undefined;
    const approvalContext = () => ({
      cfg: params.commandParams.cfg,
      accountId,
      approvalKind: "exec" as const,
      request,
    });
    const capabilities = await native.describeDeliveryCapabilities(approvalContext());
    if (!capabilities.enabled || !capabilities.supportsApproverDmSurface) {
      continue;
    }
    const resolvedTargets = await native.resolveApproverDmTargets(approvalContext());
    for (const target of resolvedTargets) {
      targets.push({
        channel: candidate.channel,
        to: target.to,
        accountId,
        threadId: target.threadId,
      });
    }
  }
  const owners = commandParams.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(owners) || owners.length === 0) {
    return [];
  }
  return dedupeByKey(targets, (target) =>
    [
      target.channel,
      target.to,
      target.accountId ?? "",
      target.threadId == null ? "" : String(target.threadId),
    ].join("\0"),
  )
    .map((target) => {
      const keys = buildPrivateCommandRouteOwnerKeys(target);
      const ownerPreference = owners.findIndex((owner) =>
        keys.has(normalizeLowercaseStringOrEmpty(String(owner))),
      );
      return {
        target,
        ownerPreference,
        originPreference: target.channel === originChannel ? 0 : 1,
      };
    })
    .filter((entry) => entry.ownerPreference !== -1)
    .toSorted(
      (a, b) => a.originPreference - b.originPreference || a.ownerPreference - b.ownerPreference,
    )
    .map((entry) => entry.target);
}

/** Tries private targets in priority order until delivery stops or owns further recovery. */
export async function deliverPrivateCommandReply(params: {
  commandParams: HandleCommandsParams;
  targets: PrivateCommandRouteTarget[];
  reply: ReplyPayload;
}): Promise<"delivered" | "pending" | "suppressed" | "failed"> {
  for (const target of params.targets) {
    const result = await routeReply({
      payload: params.reply,
      channel: target.channel as OriginatingChannelType,
      to: target.to,
      accountId: target.accountId ?? undefined,
      threadId: target.threadId ?? undefined,
      cfg: params.commandParams.cfg,
      agentId: params.commandParams.agentId,
      sessionKey: params.commandParams.sessionKey,
      policyConversationType: "direct",
      mirror: false,
      isGroup: false,
      replyKind: "final",
    }).catch(() => undefined);
    // Transport failures resolve with custody; rejection is a pre-send preparation failure.
    if (!result) {
      continue;
    }
    if (result.queueCustody === "held" || result.ambiguous) {
      return "pending";
    }
    if (result.delivered) {
      return "delivered";
    }
    if (result.suppressed) {
      return "suppressed";
    }
  }
  return "failed";
}

function readCommandMessageThreadId(params: HandleCommandsParams): string | undefined {
  return typeof params.ctx.MessageThreadId === "string" ||
    typeof params.ctx.MessageThreadId === "number"
    ? String(params.ctx.MessageThreadId)
    : undefined;
}

function readCommandDeliveryTarget(params: HandleCommandsParams): string | undefined {
  return (
    normalizeOptionalString(params.ctx.OriginatingTo) ??
    normalizeOptionalString(params.command.to) ??
    normalizeOptionalString(params.command.from)
  );
}

/**
 * Resolves where an exec approval prompt for a command should be delivered:
 * the private owner-DM target when one was resolved, else the originating
 * command surface. The originating reviewer device stays separate from a
 * private delivery target so command handlers cannot drop approval custody.
 */
export function buildCommandExecApprovalDefaults(
  commandParams: HandleCommandsParams,
  privateApprovalTarget?: PrivateCommandRouteTarget,
): ExecToolDefaults {
  return {
    host: "gateway",
    security: "allowlist",
    ask: "always",
    allowBackground: true,
    cwd: commandParams.workspaceDir,
    sessionKey: commandParams.sessionKey,
    eventRouting: {
      mainKey: commandParams.cfg.session?.mainKey,
      sessionScope: commandParams.cfg.session?.scope,
    },
    messageProvider: privateApprovalTarget?.channel ?? commandParams.command.channel,
    currentChannelId: privateApprovalTarget?.to ?? readCommandDeliveryTarget(commandParams),
    currentThreadTs: privateApprovalTarget
      ? privateApprovalTarget.threadId == null
        ? undefined
        : String(privateApprovalTarget.threadId)
      : readCommandMessageThreadId(commandParams),
    accountId: privateApprovalTarget
      ? (privateApprovalTarget.accountId ?? undefined)
      : (commandParams.ctx.AccountId ?? undefined),
    approvalReviewerDeviceId: normalizeOptionalString(commandParams.ctx.ApprovalReviewerDeviceId),
    notifyOnExit: commandParams.cfg.tools?.exec?.notifyOnExit,
    notifyOnExitEmptySuccess: commandParams.cfg.tools?.exec?.notifyOnExitEmptySuccess,
  };
}

function listPrivateCommandRouteCandidateChannels(originChannel: string) {
  const plugins = [getLoadedChannelPlugin(originChannel), ...listChannelPlugins()].filter(
    (plugin): plugin is NonNullable<ReturnType<typeof getLoadedChannelPlugin>> =>
      Boolean(plugin?.id),
  );
  return dedupeByKey(
    plugins
      .map((plugin) => ({ channel: normalizeOptionalString(plugin.id) ?? "", plugin }))
      .filter(({ channel }) => channel),
    ({ channel }) => channel,
  );
}

function buildPrivateCommandRouteOwnerKeys(target: PrivateCommandRouteTarget): Set<string> {
  const channel = normalizeLowercaseStringOrEmpty(target.channel);
  const to = normalizeLowercaseStringOrEmpty(target.to);
  const keys = new Set<string>();
  if (to) {
    keys.add(to);
    keys.add(`user:${to}`);
  }
  if (channel && to) {
    keys.add(`${channel}:${to}`);
    for (const prefix of getLoadedChannelPlugin(channel)?.messaging?.targetPrefixes ?? []) {
      const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
      if (normalizedPrefix) {
        keys.add(`${normalizedPrefix}:${to}`);
      }
    }
  }
  return keys;
}
