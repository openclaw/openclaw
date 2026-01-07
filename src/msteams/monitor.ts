import {
  chunkMarkdownText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ClawdbotConfig } from "../config/types.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveMSTeamsCredentials } from "./token.js";

const log = getChildLogger({ name: "msteams" });

export type MonitorMSTeamsOpts = {
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

export type MonitorMSTeamsResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

type TeamsActivity = {
  id?: string;
  type?: string;
  timestamp?: string | Date;
  text?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: {
    id?: string;
    conversationType?: string;
    tenantId?: string;
    isGroup?: boolean;
  };
  channelId?: string;
  serviceUrl?: string;
  membersAdded?: Array<{ id?: string; name?: string }>;
};

type TeamsTurnContext = {
  activity: TeamsActivity;
  sendActivity: (textOrActivity: string | object) => Promise<unknown>;
  sendActivities?: (
    activities: Array<{ type: string } & Record<string, unknown>>,
  ) => Promise<unknown>;
};

// Helper to convert timestamp to Date
function parseTimestamp(ts?: string | Date): Date | undefined {
  if (!ts) return undefined;
  if (ts instanceof Date) return ts;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function monitorMSTeamsProvider(
  opts: MonitorMSTeamsOpts,
): Promise<MonitorMSTeamsResult> {
  const cfg = opts.cfg;
  const msteamsCfg = cfg.msteams;
  if (!msteamsCfg?.enabled) {
    log.debug("msteams provider disabled");
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    log.error("msteams credentials not configured");
    return { app: null, shutdown: async () => {} };
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const port = msteamsCfg.webhook?.port ?? 3978;
  const textLimit = resolveTextChunkLimit(cfg, "msteams");

  log.info(`starting provider (port ${port})`);

  // Dynamic import to avoid loading SDK when provider is disabled
  const agentsHosting = await import("@microsoft/agents-hosting");
  const { startServer } = await import("@microsoft/agents-hosting-express");

  const { ActivityHandler } = agentsHosting;

  // Helper to deliver replies via Teams SDK
  async function deliverReplies(params: {
    replies: ReplyPayload[];
    context: TeamsTurnContext;
  }) {
    const chunkLimit = Math.min(textLimit, 4000);
    for (const payload of params.replies) {
      const mediaList =
        payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const text = payload.text ?? "";
      if (!text && mediaList.length === 0) continue;

      if (mediaList.length === 0) {
        for (const chunk of chunkMarkdownText(text, chunkLimit)) {
          const trimmed = chunk.trim();
          if (!trimmed || trimmed === SILENT_REPLY_TOKEN) continue;
          await params.context.sendActivity(trimmed);
        }
      } else {
        // For media, send text first then media URLs as separate messages
        if (text.trim() && text.trim() !== SILENT_REPLY_TOKEN) {
          for (const chunk of chunkMarkdownText(text, chunkLimit)) {
            await params.context.sendActivity(chunk);
          }
        }
        for (const mediaUrl of mediaList) {
          // Teams supports adaptive cards for rich media, but for now just send URL
          await params.context.sendActivity(mediaUrl);
        }
      }
    }
  }

  // Strip Teams @mention HTML tags from message text
  function stripMentionTags(text: string): string {
    // Teams wraps mentions in <at>...</at> tags
    return text.replace(/<at>.*?<\/at>/gi, "").trim();
  }

  // Handler for incoming messages
  async function handleTeamsMessage(context: TeamsTurnContext) {
    const activity = context.activity;
    const rawText = activity.text?.trim() ?? "";
    const text = stripMentionTags(rawText);
    const from = activity.from;
    const conversation = activity.conversation;

    log.info("received message", {
      rawText: rawText.slice(0, 50),
      text: text.slice(0, 50),
      from: from?.id,
      conversation: conversation?.id,
    });

    if (!text) {
      log.debug("skipping empty message after stripping mentions");
      return;
    }
    if (!from?.id) {
      log.debug("skipping message without from.id");
      return;
    }

    // Teams conversation.id may include ";messageid=..." suffix - strip it for session key
    const rawConversationId = conversation?.id ?? "";
    const conversationId = rawConversationId.split(";")[0];
    const conversationType = conversation?.conversationType ?? "personal";
    const isGroupChat =
      conversationType === "groupChat" || conversation?.isGroup === true;
    const isChannel = conversationType === "channel";
    const isDirectMessage = !isGroupChat && !isChannel;

    const senderName = from.name ?? from.id;
    const senderId = from.aadObjectId ?? from.id;

    // Build Teams-specific identifiers
    const teamsFrom = isDirectMessage
      ? `msteams:${senderId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`;
    const teamsTo = isDirectMessage
      ? `user:${senderId}`
      : `conversation:${conversationId}`;

    // Resolve routing
    const route = resolveAgentRoute({
      cfg,
      provider: "msteams",
      peer: {
        kind: isDirectMessage ? "dm" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
    });

    const preview = text.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
    });

    // Format the message body with envelope
    const timestamp = parseTimestamp(activity.timestamp);
    const body = formatAgentEnvelope({
      provider: "Teams",
      from: senderName,
      timestamp,
      body: text,
    });

    // Build context payload for agent
    const ctxPayload = {
      Body: body,
      From: teamsFrom,
      To: teamsTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : isChannel ? "room" : "group",
      GroupSubject: !isDirectMessage ? conversationType : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "msteams" as const,
      Surface: "msteams" as const,
      MessageSid: activity.id,
      Timestamp: timestamp?.getTime() ?? Date.now(),
      WasMentioned: !isDirectMessage,
      CommandAuthorized: true,
      OriginatingChannel: "msteams" as const,
      OriginatingTo: teamsTo,
    };

    if (shouldLogVerbose()) {
      logVerbose(
        `msteams inbound: from=${ctxPayload.From} preview="${preview}"`,
      );
    }

    // Send typing indicator
    const sendTypingIndicator = async () => {
      try {
        if (context.sendActivities) {
          await context.sendActivities([{ type: "typing" }]);
        }
      } catch {
        // Typing indicator is best-effort
      }
    };

    // Create reply dispatcher
    const { dispatcher, replyOptions, markDispatchIdle } =
      createReplyDispatcherWithTyping({
        responsePrefix: cfg.messages?.responsePrefix,
        deliver: async (payload) => {
          await deliverReplies({
            replies: [payload],
            context,
          });
        },
        onError: (err, info) => {
          runtime.error?.(
            danger(`msteams ${info.kind} reply failed: ${String(err)}`),
          );
        },
        onReplyStart: sendTypingIndicator,
      });

    // Dispatch to agent
    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const { queuedFinal, counts } = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      });

      markDispatchIdle();
      log.info("dispatch complete", { queuedFinal, counts });

      if (!queuedFinal) return;
      if (shouldLogVerbose()) {
        const finalCount = counts.final;
        logVerbose(
          `msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`,
        );
      }
    } catch (err) {
      log.error("dispatch failed", { error: String(err) });
      runtime.error?.(danger(`msteams dispatch failed: ${String(err)}`));
      // Try to send error message back to Teams
      try {
        await context.sendActivity(
          `⚠️ Agent failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Best effort
      }
    }
  }

  // Create activity handler using fluent API
  // The SDK's TurnContext is compatible with our TeamsTurnContext
  const handler = new ActivityHandler()
    .onMessage(async (context, next) => {
      try {
        await handleTeamsMessage(context as unknown as TeamsTurnContext);
      } catch (err) {
        runtime.error?.(danger(`msteams handler failed: ${String(err)}`));
      }
      await next();
    })
    .onMembersAdded(async (context, next) => {
      const membersAdded = context.activity?.membersAdded ?? [];
      for (const member of membersAdded) {
        if (member.id !== context.activity?.recipient?.id) {
          log.debug("member added", { member: member.id });
          // Don't send welcome message - let the user initiate conversation
        }
      }
      await next();
    });

  // Auth configuration using the new SDK format
  const authConfig = {
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  };

  // Set env vars that startServer reads (it uses loadAuthConfigFromEnv internally)
  process.env.clientId = creds.appId;
  process.env.clientSecret = creds.appPassword;
  process.env.tenantId = creds.tenantId;
  process.env.PORT = String(port);

  // Start the server
  const expressApp = startServer(handler, authConfig);

  log.info(`msteams provider started on port ${port}`);

  const shutdown = async () => {
    log.info("shutting down msteams provider");
    // Express app doesn't have a direct close method
    // The server is managed by startServer internally
  };

  // Handle abort signal
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => {
      void shutdown();
    });
  }

  return { app: expressApp, shutdown };
}
