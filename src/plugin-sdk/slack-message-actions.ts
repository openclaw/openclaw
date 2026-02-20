import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { readNumberParam, readStringParam } from "../agents/tools/common.js";
import type { ChannelMessageActionContext } from "../channels/plugins/types.js";
import { parseSlackBlocksInput } from "../slack/blocks-input.js";
import { parseSlackModalViewInput } from "../slack/views-input.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: ChannelMessageActionContext["cfg"],
  toolContext?: ChannelMessageActionContext["toolContext"],
) => Promise<AgentToolResult<unknown>>;

function readSlackBlocksParam(actionParams: Record<string, unknown>) {
  return parseSlackBlocksInput(actionParams.blocks) as Record<string, unknown>[] | undefined;
}

function readSlackModalViewParam(actionParams: Record<string, unknown>) {
  return parseSlackModalViewInput(actionParams.view) as Record<string, unknown>;
}

export async function handleSlackMessageAction(params: {
  providerId: string;
  ctx: ChannelMessageActionContext;
  invoke: SlackActionInvoke;
  normalizeChannelId?: (channelId: string) => string;
  includeReadThreadId?: boolean;
}): Promise<AgentToolResult<unknown>> {
  const { providerId, ctx, invoke, normalizeChannelId, includeReadThreadId = false } = params;
  const { action, cfg, params: actionParams } = ctx;
  const accountId = ctx.accountId ?? undefined;
  const resolveChannelId = () => {
    const channelId =
      readStringParam(actionParams, "channelId") ??
      readStringParam(actionParams, "to", { required: true });
    return normalizeChannelId ? normalizeChannelId(channelId) : channelId;
  };

  if (action === "send") {
    const to = readStringParam(actionParams, "to", { required: true });
    const content = readStringParam(actionParams, "message", {
      required: false,
      allowEmpty: true,
    });
    const mediaUrl = readStringParam(actionParams, "media", { trim: false });
    const blocks = readSlackBlocksParam(actionParams);
    if (!content && !mediaUrl && !blocks) {
      throw new Error("Slack send requires message, blocks, or media.");
    }
    if (mediaUrl && blocks) {
      throw new Error("Slack send does not support blocks with media.");
    }
    const threadId = readStringParam(actionParams, "threadId");
    const replyTo = readStringParam(actionParams, "replyTo");
    return await invoke(
      {
        action: "sendMessage",
        to,
        content: content ?? "",
        mediaUrl: mediaUrl ?? undefined,
        blocks,
        accountId,
        threadTs: threadId ?? replyTo ?? undefined,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "react") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const emoji = readStringParam(actionParams, "emoji", { allowEmpty: true });
    const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : undefined;
    return await invoke(
      {
        action: "react",
        channelId: resolveChannelId(),
        messageId,
        emoji,
        remove,
        accountId,
      },
      cfg,
    );
  }

  if (action === "reactions") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await invoke(
      {
        action: "reactions",
        channelId: resolveChannelId(),
        messageId,
        limit,
        accountId,
      },
      cfg,
    );
  }

  if (action === "read") {
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    const readAction: Record<string, unknown> = {
      action: "readMessages",
      channelId: resolveChannelId(),
      limit,
      before: readStringParam(actionParams, "before"),
      after: readStringParam(actionParams, "after"),
      accountId,
    };
    if (includeReadThreadId) {
      readAction.threadId = readStringParam(actionParams, "threadId");
    }
    return await invoke(readAction, cfg);
  }

  if (action === "edit") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const content = readStringParam(actionParams, "message", { allowEmpty: true });
    const blocks = readSlackBlocksParam(actionParams);
    if (!content && !blocks) {
      throw new Error("Slack edit requires message or blocks.");
    }
    return await invoke(
      {
        action: "editMessage",
        channelId: resolveChannelId(),
        messageId,
        content: content ?? "",
        blocks,
        accountId,
      },
      cfg,
    );
  }

  if (action === "delete") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    return await invoke(
      {
        action: "deleteMessage",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
    );
  }

  if (action === "modal-open") {
    const triggerId = readStringParam(actionParams, "triggerId", { required: true });
    const view = readSlackModalViewParam(actionParams);
    return await invoke(
      {
        action: "openModal",
        triggerId,
        view,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "modal-push") {
    const triggerId = readStringParam(actionParams, "triggerId", { required: true });
    const view = readSlackModalViewParam(actionParams);
    return await invoke(
      {
        action: "pushModal",
        triggerId,
        view,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "modal-update") {
    const view = readSlackModalViewParam(actionParams);
    const viewId = readStringParam(actionParams, "viewId");
    const externalId = readStringParam(actionParams, "externalId");
    const hash = readStringParam(actionParams, "hash");
    if (!viewId && !externalId) {
      throw new Error("Slack modal-update requires viewId or externalId.");
    }
    return await invoke(
      {
        action: "updateModal",
        view,
        viewId,
        externalId,
        hash,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const messageId =
      action === "list-pins"
        ? undefined
        : readStringParam(actionParams, "messageId", { required: true });
    return await invoke(
      {
        action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
    );
  }

  if (action === "member-info") {
    const userId = readStringParam(actionParams, "userId", { required: true });
    return await invoke({ action: "memberInfo", userId, accountId }, cfg);
  }

  if (action === "emoji-list") {
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await invoke({ action: "emojiList", limit, accountId }, cfg);
  }

  throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
