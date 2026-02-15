import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { MessengerWebhookBody, ResolvedMessengerAccount } from "./types.js";
import { chunkMarkdownText } from "../auto-reply/chunk.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { danger, logVerbose } from "../globals.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { resolveMessengerAccount } from "./accounts.js";
import { handleMessengerWebhookEvents } from "./bot-handlers.js";
import { sendMessageMessenger, sendSenderAction } from "./send.js";
import { validateMessengerSignature } from "./signature.js";

export interface MonitorMessengerProviderOptions {
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
  accountId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPath?: string;
}

export interface MessengerProviderMonitor {
  account: ResolvedMessengerAccount;
  stop: () => void;
}

const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getMessengerRuntimeState(accountId: string) {
  return runtimeState.get(`messenger:${accountId}`);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function monitorMessengerProvider(
  opts: MonitorMessengerProviderOptions,
): Promise<MessengerProviderMonitor> {
  const {
    pageAccessToken,
    appSecret,
    verifyToken,
    accountId,
    config,
    runtime,
    abortSignal,
    webhookPath,
  } = opts;
  const resolvedAccountId = accountId ?? "default";

  const account = resolveMessengerAccount({
    cfg: config,
    accountId: resolvedAccountId,
  });

  recordChannelRuntimeState({
    channel: "messenger",
    accountId: resolvedAccountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  const normalizedPath =
    normalizePluginHttpPath(webhookPath, "/messenger/webhook") ?? "/messenger/webhook";
  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    pluginId: "messenger",
    accountId: resolvedAccountId,
    log: (msg) => logVerbose(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // Handle GET requests for webhook verification
      if (req.method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        if (mode === "subscribe" && token === verifyToken) {
          logVerbose("messenger: webhook verification successful");
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain");
          res.end(challenge ?? "");
          return;
        }

        logVerbose("messenger: webhook verification failed (invalid verify token)");
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      // Only accept POST requests
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      try {
        const rawBody = await readRequestBody(req);
        const signature = req.headers["x-hub-signature-256"];

        // Validate signature
        if (!signature || typeof signature !== "string") {
          logVerbose("messenger: webhook missing X-Hub-Signature-256 header");
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing X-Hub-Signature-256 header" }));
          return;
        }

        if (!validateMessengerSignature(rawBody, signature, appSecret)) {
          logVerbose("messenger: webhook signature validation failed");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }

        const body = JSON.parse(rawBody) as MessengerWebhookBody;

        // Respond immediately with 200 to avoid Meta timeout
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));

        // Process entries asynchronously
        if (body.entry && body.entry.length > 0) {
          for (const entry of body.entry) {
            if (!entry.messaging || entry.messaging.length === 0) {
              continue;
            }

            logVerbose(`messenger: received ${entry.messaging.length} messaging events`);

            recordChannelRuntimeState({
              channel: "messenger",
              accountId: resolvedAccountId,
              state: { lastInboundAt: Date.now() },
            });

            // Send sender actions for message events
            for (const event of entry.messaging) {
              if (event.message || event.postback) {
                void sendSenderAction(event.sender.id, "mark_seen", {
                  pageAccessToken,
                  accountId: resolvedAccountId,
                }).catch(() => {});
                void sendSenderAction(event.sender.id, "typing_on", {
                  pageAccessToken,
                  accountId: resolvedAccountId,
                }).catch(() => {});
              }
            }

            await handleMessengerWebhookEvents(entry.messaging, {
              cfg: config,
              account,
              runtime,
              processMessage: async (ctx) => {
                if (!ctx) {
                  return;
                }

                const { ctxPayload, route } = ctx;

                const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
                  cfg: config,
                  agentId: route.agentId,
                  channel: "messenger",
                  accountId: route.accountId,
                });

                try {
                  const textLimit = 2000; // Messenger max message length

                  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
                    ctx: ctxPayload,
                    cfg: config,
                    dispatcherOptions: {
                      ...prefixOptions,
                      deliver: async (payload, _info) => {
                        // Send typing indicator before delivery
                        void sendSenderAction(ctx.userId, "typing_on", {
                          pageAccessToken,
                          accountId: resolvedAccountId,
                        }).catch(() => {});

                        const text = payload.text?.trim() ?? "";
                        const mediaUrls =
                          payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);

                        // Send media
                        for (const url of mediaUrls) {
                          if (url?.trim()) {
                            try {
                              await sendMessageMessenger(ctx.userId, "", {
                                pageAccessToken,
                                accountId: resolvedAccountId,
                                mediaUrl: url.trim(),
                              });
                            } catch (err) {
                              logVerbose(`messenger: media send failed: ${String(err)}`);
                            }
                          }
                        }

                        // Send text chunks
                        if (text) {
                          const chunks = chunkMarkdownText(text, textLimit);
                          for (const chunk of chunks) {
                            await sendMessageMessenger(ctx.userId, chunk, {
                              pageAccessToken,
                              accountId: resolvedAccountId,
                            });
                          }
                        }

                        recordChannelRuntimeState({
                          channel: "messenger",
                          accountId: resolvedAccountId,
                          state: { lastOutboundAt: Date.now() },
                        });
                      },
                      onError: (err, info) => {
                        runtime.error?.(
                          danger(`messenger ${info.kind} reply failed: ${String(err)}`),
                        );
                      },
                    },
                    replyOptions: {
                      onModelSelected,
                    },
                  });

                  if (!queuedFinal) {
                    logVerbose(
                      `messenger: no response generated for message from ${ctxPayload.From}`,
                    );
                  }
                } catch (err) {
                  runtime.error?.(danger(`messenger: auto-reply failed: ${String(err)}`));

                  // Send error message to user
                  try {
                    await sendMessageMessenger(
                      ctx.userId,
                      "Sorry, I encountered an error processing your message.",
                      {
                        pageAccessToken,
                        accountId: resolvedAccountId,
                      },
                    );
                  } catch (replyErr) {
                    runtime.error?.(danger(`messenger: error reply failed: ${String(replyErr)}`));
                  }
                }
              },
            }).catch((err) => {
              runtime.error?.(danger(`messenger webhook handler failed: ${String(err)}`));
            });
          }
        }
      } catch (err) {
        runtime.error?.(danger(`messenger webhook error: ${String(err)}`));
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    },
  });

  logVerbose(`messenger: registered webhook handler at ${normalizedPath}`);

  const stopHandler = () => {
    logVerbose(`messenger: stopping provider for account ${resolvedAccountId}`);
    unregisterHttp();
    recordChannelRuntimeState({
      channel: "messenger",
      accountId: resolvedAccountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  abortSignal?.addEventListener("abort", stopHandler);

  return {
    account,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
