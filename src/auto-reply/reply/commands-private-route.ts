import {
  getLoadedChannelPlugin,
  resolveChannelApprovalAdapter,
} from "../../channels/plugins/index.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
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

export async function resolvePrivateCommandRouteTargets(params: {
  commandParams: HandleCommandsParams;
  request: ExecApprovalRequest;
}): Promise<PrivateCommandRouteTarget[]> {
  const adapter = resolveChannelApprovalAdapter(
    getLoadedChannelPlugin(params.commandParams.command.channel),
  );
  const native = adapter?.native;
  if (!native?.resolveApproverDmTargets) {
    return [];
  }
  const accountId = params.commandParams.ctx.AccountId ?? undefined;
  const capabilities = native.describeDeliveryCapabilities({
    cfg: params.commandParams.cfg,
    accountId,
    approvalKind: "exec",
    request: params.request,
  });
  if (!capabilities.enabled || !capabilities.supportsApproverDmSurface) {
    return [];
  }
  const targets = await native.resolveApproverDmTargets({
    cfg: params.commandParams.cfg,
    accountId,
    approvalKind: "exec",
    request: params.request,
  });
  return dedupePrivateCommandRouteTargets(
    targets.map((target) => ({
      channel: params.commandParams.command.channel,
      to: target.to,
      accountId,
      threadId: target.threadId,
    })),
  );
}

export async function deliverPrivateCommandReply(params: {
  commandParams: HandleCommandsParams;
  targets: PrivateCommandRouteTarget[];
  reply: ReplyPayload;
}): Promise<boolean> {
  const results = await Promise.allSettled(
    params.targets.map((target) =>
      routeReply({
        payload: params.reply,
        channel: target.channel as OriginatingChannelType,
        to: target.to,
        accountId: target.accountId ?? undefined,
        threadId: target.threadId ?? undefined,
        cfg: params.commandParams.cfg,
        sessionKey: params.commandParams.sessionKey,
        policyConversationType: "direct",
        mirror: false,
        isGroup: false,
      }),
    ),
  );
  return results.some((result) => result.status === "fulfilled" && result.value.ok);
}

export function readCommandMessageThreadId(params: HandleCommandsParams): string | undefined {
  return typeof params.ctx.MessageThreadId === "string" ||
    typeof params.ctx.MessageThreadId === "number"
    ? String(params.ctx.MessageThreadId)
    : undefined;
}

export function readCommandDeliveryTarget(params: HandleCommandsParams): string | undefined {
  return (
    normalizeOptionalString(params.ctx.OriginatingTo) ??
    normalizeOptionalString(params.command.to) ??
    normalizeOptionalString(params.command.from)
  );
}

function dedupePrivateCommandRouteTargets(
  targets: PrivateCommandRouteTarget[],
): PrivateCommandRouteTarget[] {
  const seen = new Set<string>();
  const deduped: PrivateCommandRouteTarget[] = [];
  for (const target of targets) {
    const key = [
      target.channel,
      target.to,
      target.accountId ?? "",
      target.threadId == null ? "" : String(target.threadId),
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}
