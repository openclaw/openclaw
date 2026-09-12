import {
  formatCommandOwnerHint,
  hasConfiguredCommandOwners,
} from "../../commands/doctor-command-owner.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { buildCommandContext } from "./commands-context.js";
import { resolveCommandContextText } from "./context-text.js";

/** Offer a command, never execute an update from natural-language or model text. */
export function resolveUpdateRequestReply(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
}): ReplyPayload | undefined {
  const { ctx, cfg } = params;
  const text = resolveCommandContextText(ctx);
  if (
    !/\bupdate\s+openclaw\b/i.test(text) ||
    ctx.InternalTurnSource ||
    (ctx.InputProvenance && ctx.InputProvenance.kind !== "external_user") ||
    !ctx.CommandAuthorized
  ) {
    return undefined;
  }
  const command = buildCommandContext({
    ctx,
    cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    isGroup: ctx.ChatType === "group" || ctx.ChatType === "channel",
    triggerBodyNormalized: text,
    commandAuthorized: ctx.CommandAuthorized,
  });
  if (
    !/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?update\s+openclaw(?:\s+now)?(?:,?\s+please)?[.!?]*$/i.test(
      command.commandBodyNormalized.trim(),
    )
  ) {
    return undefined;
  }
  if (!command.senderIsOwner) {
    const setupHint = hasConfiguredCommandOwners(cfg)
      ? ""
      : " The operator can use channel setup in the Control UI or run `openclaw channels add` to set up their own account for administration.";
    return {
      text: `Your chat account can talk to OpenClaw, but is not configured as an owner. ${formatCommandOwnerHint({ channel: command.channel, id: command.senderId })}${setupHint}`,
    };
  }
  if (!command.isAuthorizedSender) {
    return { text: "Updates are not allowed for this account by the command access policy." };
  }
  if (!isRestartEnabled(cfg)) {
    return { text: "Updates from chat are disabled (commands.restart=false)." };
  }
  return {
    text: "Update this OpenClaw installation using its configured release channel? It may restart the Gateway. Select Update now or send `/update` to continue.",
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Update now",
              style: "primary",
              reusable: true,
              action: { type: "command", command: "/update" },
            },
          ],
        },
      ],
    },
  };
}
