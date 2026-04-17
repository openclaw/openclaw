import { Routes } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { RouterConfig, InstanceConfig } from "./config.js";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";

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

  const inflight = new Set<string>();
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let lastSequence: number | null = null;
  let sessionId: string | undefined;
  let resumeGatewayUrl: string | undefined;

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
          }

          if (t === "MESSAGE_CREATE") {
            const authorId = d.author?.id;
            const isBot = d.author?.bot === true;
            const guildId = d.guild_id;
            const content = d.content ?? "";
            const channelId = d.channel_id;

            runtime.log(
              `[router] MESSAGE_CREATE: author=${authorId} guild=${guildId ?? "dm"} content=${content.slice(0, 40)}`,
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
      // Auto-reconnect unless we explicitly shut down
      if (code !== 1000) {
        setTimeout(() => connect(!!sessionId), 5000);
      }
    });

    ws.on("error", (err: Error) => {
      runtime.error(`[router] WebSocket error: ${err.message}`);
    });
  }

  connect(false);

  // Keep running until process exit
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

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
          channel: "internal",
          deliver: false,
          idempotencyKey,
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
    } finally {
      clearInterval(typingInterval);
    }
  } catch (err) {
    runtime.error(`[router] error for ${discordUserId}: ${formatErrorMessage(err)}`);
    await discordSend(
      discordToken,
      channelId,
      "*Sorry, something went wrong processing your message.*",
    ).catch(() => {});
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
