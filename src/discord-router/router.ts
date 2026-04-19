import { Routes } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { RouterConfig, InstanceConfig } from "./config.js";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { markOnboarded } from "./config.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";

type AgentResult = {
  runId: string;
  status: string;
  result?: {
    payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
  };
};

export type RouterRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const TYPING_INTERVAL_MS = 8_000;
const DISCORD_API = "https://discord.com/api/v10";

/**
 * Start the Discord router using raw WebSocket connection to Discord gateway.
 * Listens for DMs and forwards them to per-user Docker containers via gateway API.
 */
export async function startRouter(config: RouterConfig, runtime: RouterRuntime): Promise<void> {
  const { discordToken, instances, agentTimeoutMs } = config;

  // Resolve application ID
  const appIdResponse = (await fetch(`${DISCORD_API}/applications/@me`, {
    headers: { Authorization: `Bot ${discordToken}` },
  }).then((r) => r.json())) as { id?: string };
  const applicationId = appIdResponse?.id;
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application ID");
  }
  runtime.log(`[router] application id: ${applicationId}`);
  runtime.log(`[router] instances: ${instances.size}`);
  for (const [userId, inst] of instances) {
    runtime.log(`  ${userId} → localhost:${inst.port}`);
  }

  // Get gateway URL
  const gatewayInfo = (await fetch(`${DISCORD_API}/gateway/bot`, {
    headers: { Authorization: `Bot ${discordToken}` },
  }).then((r) => r.json())) as { url?: string };
  const gatewayUrl = gatewayInfo?.url ?? "wss://gateway.discord.gg";

  // Start OAuth callback server for Google auth relay
  const oauth = startOAuthCallbackServer({
    instancesDir: config.instancesDir,
    runtime,
  });

  const inflight = new Set<string>();
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let lastSequence: number | null = null;
  let sessionId: string | undefined;
  let resumeGatewayUrl: string | undefined;
  let shuttingDown = false;

  function connect(resume = false) {
    const url = resume && resumeGatewayUrl ? resumeGatewayUrl : gatewayUrl;
    const ws = new WebSocket(`${url}/?v=10&encoding=json`);

    ws.on("open", () => {
      runtime.log(`[router] WebSocket connected to ${url}`);
    });

    ws.on("message", (raw: Buffer) => {
      const payload = JSON.parse(raw.toString());
      const { op, d, s, t } = payload;

      if (s !== null && s !== undefined) {
        lastSequence = s;
      }

      switch (op) {
        case 10: {
          // Hello — start heartbeating
          const interval = d.heartbeat_interval;
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          heartbeatInterval = setInterval(() => {
            ws.send(JSON.stringify({ op: 1, d: lastSequence }));
          }, interval);
          // Send initial heartbeat
          ws.send(JSON.stringify({ op: 1, d: lastSequence }));

          if (resume && sessionId) {
            // Resume
            ws.send(
              JSON.stringify({
                op: 6,
                d: { token: `Bot ${discordToken}`, session_id: sessionId, seq: lastSequence },
              }),
            );
          } else {
            // Identify
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: `Bot ${discordToken}`,
                  intents:
                    (1 << 0) | // GUILDS
                    (1 << 9) | // GUILD_MESSAGES
                    (1 << 12) | // DIRECT_MESSAGES
                    (1 << 15), // MESSAGE_CONTENT
                  properties: {
                    os: "linux",
                    browser: "openclaw-router",
                    device: "openclaw-router",
                  },
                },
              }),
            );
          }
          break;
        }
        case 11:
          // Heartbeat ACK
          break;
        case 0: {
          // Dispatch
          if (t === "READY") {
            sessionId = d.session_id;
            resumeGatewayUrl = d.resume_gateway_url;
            const botUser = d.user;
            runtime.log(`[router] logged in as ${botUser?.id ?? "unknown"} (${botUser?.username})`);

            // Proactively onboard users who haven't been onboarded yet
            void onboardNewUsers(
              discordToken,
              instances,
              config,
              runtime,
              agentTimeoutMs,
              inflight,
            );
          }

          if (t === "MESSAGE_CREATE") {
            const authorId = d.author?.id;
            const isBot = d.author?.bot === true;
            const guildId = d.guild_id;
            let content = d.content ?? "";
            const channelId = d.channel_id;

            // Include reply context so the agent knows what message is being responded to
            const ref = d.referenced_message;
            if (ref && typeof ref === "object") {
              const refAuthor = ref.author?.username ?? "unknown";
              const refContent = (ref.content ?? "").slice(0, 500);
              if (refContent) {
                content = `[Replying to ${refAuthor}: "${refContent}"]\n${content}`;
              }
            }

            runtime.log(
              `[router] MESSAGE_CREATE: author=${authorId} guild=${guildId ?? "dm"} reply=${!!ref} content=${content.slice(0, 60)}`,
            );

            if (!authorId || isBot || guildId || !content.trim()) {
              return;
            }

            const instance = instances.get(authorId);
            if (!instance) {
              runtime.log(`[router] no instance for user ${authorId}`);
              void discordSend(
                discordToken,
                channelId,
                "*No agent is configured for your account.*",
              );
              return;
            }

            void routeDM({
              discordUserId: authorId,
              channelId,
              messageContent: content,
              instance,
              discordToken,
              runtime,
              agentTimeoutMs,
              inflight,
            });
          }
          break;
        }
        case 7:
          // Reconnect requested
          runtime.log("[router] reconnect requested by Discord");
          ws.close();
          setTimeout(() => connect(true), 1000);
          break;
        case 9:
          // Invalid session
          runtime.log("[router] invalid session, re-identifying");
          sessionId = undefined;
          ws.close();
          setTimeout(() => connect(false), 5000);
          break;
      }
    });

    ws.on("close", (code: number) => {
      runtime.log(`[router] WebSocket closed (${code})`);
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
      // Always reconnect — Discord sends 1000/1001 for routine reconnects.
      // Only process exit (SIGINT/SIGTERM) should stop the router.
      if (!shuttingDown) {
        const delay = code === 4004 ? 0 : 5000; // 4004 = auth failed, don't retry
        if (code === 4004) {
          runtime.error("[router] authentication failed (4004), not reconnecting");
          return;
        }
        setTimeout(() => connect(!!sessionId), delay);
      }
    });

    ws.on("error", (err: Error) => {
      runtime.error(`[router] WebSocket error: ${err.message}`);
    });
  }

  connect(false);

  // Keep running until process exit
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      shuttingDown = true;
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/** Returns true if the agent responded successfully. */
async function routeDM(params: {
  discordUserId: string;
  channelId: string;
  messageContent: string;
  instance: InstanceConfig;
  discordToken: string;
  runtime: RouterRuntime;
  agentTimeoutMs: number;
  inflight: Set<string>;
}): Promise<void> {
  const {
    discordUserId,
    channelId,
    messageContent,
    instance,
    discordToken,
    runtime,
    agentTimeoutMs,
    inflight,
  } = params;

  // Serialize per-user
  if (inflight.has(discordUserId)) {
    runtime.log(`[router] user ${discordUserId} already in-flight, queuing`);
  }
  while (inflight.has(discordUserId)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  inflight.add(discordUserId);
  try {
    runtime.log(`[router] routing DM from ${discordUserId}: ${messageContent.slice(0, 80)}`);

    // Typing indicator
    const typingInterval = setInterval(() => {
      void discordTyping(discordToken, channelId);
    }, TYPING_INTERVAL_MS);
    void discordTyping(discordToken, channelId);

    try {
      const idempotencyKey = randomUUID();
      const result = await callGateway<AgentResult>({
        url: `ws://127.0.0.1:${instance.port}`,
        token: instance.token || undefined,
        method: "agent",
        params: {
          message: messageContent,
          channel: "webchat",
          deliver: false,
          idempotencyKey,
          sessionKey: `agent:main:discord:default:dm:${discordUserId}`,
          timeout: Math.floor(agentTimeoutMs / 1000),
        },
        expectFinal: true,
        timeoutMs: agentTimeoutMs + 30_000,
        clientName: "cli",
        mode: "backend",
      });

      const payloads = result?.result?.payloads ?? [];
      if (payloads.length === 0) {
        runtime.log(`[router] empty response for ${discordUserId}`);
        return;
      }

      for (const payload of payloads) {
        const text = payload.text?.trim();
        if (text) {
          const chunks = chunkText(text, 2000);
          for (const chunk of chunks) {
            await discordSend(discordToken, channelId, chunk);
          }
        }
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        for (const url of mediaUrls) {
          await discordSend(discordToken, channelId, url);
        }
      }

      runtime.log(`[router] delivered ${payloads.length} payload(s) to ${discordUserId}`);
      return true;
    } finally {
      clearInterval(typingInterval);
    }
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    runtime.error(`[router] error for ${discordUserId}: ${errMsg}`);

    const isConnectionRefused =
      errMsg.includes("ECONNREFUSED") || errMsg.includes("connect ECONNREFUSED");
    const isTimeout = errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT");
    const isAuthError =
      errMsg.includes("unauthorized") ||
      errMsg.includes("token_mismatch") ||
      errMsg.includes("pairing");

    if (isConnectionRefused) {
      await discordSend(
        discordToken,
        channelId,
        "*Your agent is not running. Please contact the admin to start your instance.*",
      ).catch(() => {});
    } else if (isAuthError) {
      // Don't send error to user for auth issues — admin problem
      runtime.error(`[router] auth error for ${discordUserId}, container may need restart`);
    } else if (isTimeout) {
      await discordSend(
        discordToken,
        channelId,
        "*Your agent is taking too long to respond. Please try again later.*",
      ).catch(() => {});
    } else {
      await discordSend(
        discordToken,
        channelId,
        "*Something went wrong processing your message. Please try again.*",
      ).catch(() => {});
    }
    return false;
  } finally {
    inflight.delete(discordUserId);
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < limit * 0.3) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

async function discordSend(token: string, channelId: string, content: string): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
}

async function discordTyping(token: string, channelId: string): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelTyping(channelId)}`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
  }).catch(() => {});
}

/** Open a DM channel with a user and return the channel ID. */
async function openDMChannel(token: string, userId: string): Promise<string | null> {
  const resp = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { id?: string };
  return data.id ?? null;
}

/** Send a Discord embed message. */
async function discordSendEmbed(
  token: string,
  channelId: string,
  embed: { title: string; description: string; color?: number },
): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

/**
 * Proactively message all non-onboarded users on startup.
 * Sends a welcome DM and triggers the agent to greet them.
 */
async function onboardNewUsers(
  discordToken: string,
  instances: Map<string, InstanceConfig>,
  config: RouterConfig,
  runtime: RouterRuntime,
  agentTimeoutMs: number,
  inflight: Set<string>,
): Promise<void> {
  for (const [userId, instance] of instances) {
    if (instance.onboarded) continue;

    runtime.log(`[router] proactive onboarding for ${userId}`);

    const channelId = await openDMChannel(discordToken, userId);
    if (!channelId) {
      runtime.log(`[router] could not open DM channel for ${userId}`);
      continue;
    }

    // Send welcome embed
    await discordSendEmbed(discordToken, channelId, {
      title: "Welcome to OpenClaw!",
      description:
        "I'm your personal AI assistant. Let's get you set up!\n\nI'll ask you a few quick questions to personalize your experience.",
      color: 0xff8080,
    });

    // Route through the agent so it starts a conversation
    routeDM({
      discordUserId: userId,
      channelId,
      messageContent:
        "[System: This is a brand new user who just joined. You are OpenClaw, a personal AI assistant. Do NOT refer to yourself as Claude Code or Claude — you are OpenClaw. Greet them warmly, introduce yourself as OpenClaw, and ask what they'd like to be called. Keep it brief and friendly. Do not mention Docker, containers, or any technical infrastructure.]",
      instance,
      discordToken,
      runtime,
      agentTimeoutMs,
      inflight,
    }).then((success) => {
      if (success) {
        markOnboarded(instance);
        runtime.log(`[router] onboarding complete for ${userId}`);
      } else {
        runtime.log(`[router] onboarding failed for ${userId}, will retry on next restart`);
      }
    });
  }
}
