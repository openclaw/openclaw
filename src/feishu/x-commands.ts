/**
 * X command handlers for Feishu.
 *
 * Allows triggering X/Twitter actions from Feishu messages via slash commands.
 *
 * Supported commands:
 * - /x follow @username
 * - /x unfollow @username
 * - /x like <tweet-url>
 * - /x unlike <tweet-url>
 * - /x dm @username <msg>
 * - /x me
 *
 * For natural language commands (e.g., "帮我关注一下 @elonmusk"),
 * the Agent with the x-actions skill will handle them automatically.
 */

import type { OpenClawConfig } from "../config/config.js";
import { tryCreateXService, type XService } from "../x/index.js";

export interface XCommandResult {
  handled: boolean;
  success?: boolean;
  message?: string;
  error?: string;
}

/**
 * Parse and execute X slash commands from Feishu messages.
 *
 * Only handles explicit /x commands. Natural language is handled by the Agent.
 *
 * @example
 * ```typescript
 * const xResult = await handleXCommand(ctx.text, ctx.cfg);
 * if (xResult.handled) {
 *   await ctx.reply(xResult.message ?? xResult.error ?? "Done");
 *   return;
 * }
 * ```
 */
export async function handleXCommand(
  text: string,
  cfg: OpenClawConfig,
  options?: { accountId?: string },
): Promise<XCommandResult> {
  const trimmed = text.trim();

  // Only handle explicit /x slash commands
  if (!trimmed.startsWith("/x ") && !trimmed.startsWith("/X ")) {
    return { handled: false };
  }

  // Parse command parts
  const parts = trimmed.slice(3).trim().split(/\s+/);
  const subCommand = parts[0]?.toLowerCase();

  if (!subCommand) {
    return {
      handled: true,
      success: false,
      error: "用法: /x <follow|unfollow|like|unlike|dm|me> <target> [message]",
    };
  }

  // Try to create X service
  const xService = tryCreateXService(cfg, { accountId: options?.accountId });
  if (!xService) {
    return {
      handled: true,
      success: false,
      error: "X 账号未配置。请先在配置中设置 channels.x 的凭证。",
    };
  }

  try {
    switch (subCommand) {
      case "follow":
        return await handleFollowCommand(xService, parts.slice(1));

      case "unfollow":
        return await handleUnfollowCommand(xService, parts.slice(1));

      case "like":
        return await handleLikeCommand(xService, parts.slice(1));

      case "unlike":
        return await handleUnlikeCommand(xService, parts.slice(1));

      case "dm":
        return await handleDmCommand(xService, parts.slice(1));

      case "me":
        return await handleMeCommand(xService);

      default:
        return {
          handled: true,
          success: false,
          error: `未知命令: ${subCommand}\n支持的命令: follow, unfollow, like, unlike, dm, me`,
        };
    }
  } catch (err) {
    return {
      handled: true,
      success: false,
      error: `执行失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function handleFollowCommand(xService: XService, args: string[]): Promise<XCommandResult> {
  const target = args[0];
  if (!target) {
    return {
      handled: true,
      success: false,
      error: "用法: /x follow <username>\n例如: /x follow @elonmusk",
    };
  }

  const result = await xService.followUser(target);
  if (result.ok) {
    return {
      handled: true,
      success: true,
      message: `✅ 已关注 ${target}`,
    };
  }
  return {
    handled: true,
    success: false,
    error: `关注失败: ${result.error ?? "未知错误"}`,
  };
}

async function handleUnfollowCommand(xService: XService, args: string[]): Promise<XCommandResult> {
  const target = args[0];
  if (!target) {
    return {
      handled: true,
      success: false,
      error: "用法: /x unfollow <username>\n例如: /x unfollow @elonmusk",
    };
  }

  const result = await xService.unfollowUser(target);
  if (result.ok) {
    return {
      handled: true,
      success: true,
      message: `✅ 已取消关注 ${target}`,
    };
  }
  return {
    handled: true,
    success: false,
    error: `取消关注失败: ${result.error ?? "未知错误"}`,
  };
}

async function handleLikeCommand(xService: XService, args: string[]): Promise<XCommandResult> {
  const target = args[0];
  if (!target) {
    return {
      handled: true,
      success: false,
      error: "用法: /x like <tweet-url>\n例如: /x like https://x.com/user/status/123",
    };
  }

  const result = await xService.likeTweet(target);
  if (result.ok) {
    return {
      handled: true,
      success: true,
      message: `✅ 已点赞推文`,
    };
  }
  return {
    handled: true,
    success: false,
    error: `点赞失败: ${result.error ?? "未知错误"}`,
  };
}

async function handleUnlikeCommand(xService: XService, args: string[]): Promise<XCommandResult> {
  const target = args[0];
  if (!target) {
    return {
      handled: true,
      success: false,
      error: "用法: /x unlike <tweet-url>\n例如: /x unlike https://x.com/user/status/123",
    };
  }

  const result = await xService.unlikeTweet(target);
  if (result.ok) {
    return {
      handled: true,
      success: true,
      message: `✅ 已取消点赞`,
    };
  }
  return {
    handled: true,
    success: false,
    error: `取消点赞失败: ${result.error ?? "未知错误"}`,
  };
}

async function handleDmCommand(xService: XService, args: string[]): Promise<XCommandResult> {
  const target = args[0];
  const message = args.slice(1).join(" ");

  if (!target || !message) {
    return {
      handled: true,
      success: false,
      error: "用法: /x dm <username> <message>\n例如: /x dm @elonmusk Hello!",
    };
  }

  const result = await xService.sendDM(target, message);
  if (result.ok) {
    return {
      handled: true,
      success: true,
      message: `✅ 已发送私信给 ${target}`,
    };
  }
  return {
    handled: true,
    success: false,
    error: `发送私信失败: ${result.error ?? "未知错误"}`,
  };
}

async function handleMeCommand(xService: XService): Promise<XCommandResult> {
  const me = await xService.getMe();
  return {
    handled: true,
    success: true,
    message: `当前 X 账号:\n用户名: @${me.username}\n显示名: ${me.name}\nID: ${me.id}`,
  };
}
