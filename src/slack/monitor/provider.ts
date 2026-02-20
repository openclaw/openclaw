import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import SlackBolt from "@slack/bolt";
import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "../../auto-reply/reply/history.js";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "../../channels/allowlists/resolve-utils.js";
import { loadConfig } from "../../config/config.js";
import type { SessionScope } from "../../config/sessions.js";
import { warn } from "../../globals.js";
import { installRequestBodyLimitGuard } from "../../infra/http-body.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolveSlackAccount } from "../accounts.js";
import { resolveSlackWebClientOptions } from "../client.js";
import { normalizeSlackWebhookPath, registerSlackHttpHandler } from "../http/index.js";
import { verifySlackRequestSignature } from "../http/verify.js";
import { resolveSlackChannelAllowlist } from "../resolve-channels.js";
import { resolveSlackUserAllowlist } from "../resolve-users.js";
import { resolveSlackAppToken, resolveSlackBotToken } from "../token.js";
import { normalizeAllowList } from "./allow-list.js";
import { resolveSlackSlashCommandConfig } from "./commands.js";
import { createSlackMonitorContext } from "./context.js";
import { registerSlackMonitorEvents } from "./events.js";
import { createSlackMessageHandler } from "./message-handler.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";
import type { MonitorSlackOpts } from "./types.js";

const slackBoltModule = SlackBolt as typeof import("@slack/bolt") & {
  default?: typeof import("@slack/bolt");
};
// Bun allows named imports from CJS; Node ESM doesn't. Use default+fallback for compatibility.
// Fix: Check if module has App property directly (Node 25.x ESM/CJS compat issue)
const slackBolt =
  (slackBoltModule.App ? slackBoltModule : slackBoltModule.default) ?? slackBoltModule;
const { App, HTTPReceiver } = slackBolt;

const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

function parseApiAppIdFromAppToken(raw?: string) {
  const token = raw?.trim();
  if (!token) {
    return undefined;
  }
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(token);
  return match?.[1]?.toUpperCase();
}

export async function monitorSlackProvider(opts: MonitorSlackOpts = {}) {
  const cfg = opts.config ?? loadConfig();

  let account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });

  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );

  const sessionCfg = cfg.session;
  const sessionScope: SessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);

  const slackMode = opts.mode ?? account.config.mode ?? "socket";
  const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
  const signingSecret = account.config.signingSecret?.trim();
  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  if (!botToken || (slackMode !== "http" && !appToken)) {
    const missing =
      slackMode === "http"
        ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`
        : `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`;
    throw new Error(missing);
  }
  if (slackMode === "http" && !signingSecret) {
    throw new Error(
      `Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const slackCfg = account.config;
  const dmConfig = slackCfg.dm;

  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = slackCfg.dmPolicy ?? dmConfig?.policy ?? "pairing";
  let allowFrom = slackCfg.allowFrom ?? dmConfig?.allowFrom;
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  let channelsConfig = slackCfg.channels;
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = slackCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
  if (
    slackCfg.groupPolicy === undefined &&
    slackCfg.channels === undefined &&
    defaultGroupPolicy === undefined &&
    groupPolicy === "open"
  ) {
    runtime.log?.(
      warn(
        'slack: groupPolicy defaults to "open" when channels.slack is missing; set channels.slack.groupPolicy (or channels.defaults.groupPolicy) or add channels.slack.channels to restrict access.',
      ),
    );
  }

  const resolveToken = slackCfg.userToken?.trim() || botToken;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const reactionMode = slackCfg.reactionNotifications ?? "own";
  const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
  const replyToMode = slackCfg.replyToMode ?? "all";
  const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
  const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
  const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;

  const receiver =
    slackMode === "http"
      ? new HTTPReceiver({
          signingSecret: signingSecret ?? "",
          endpoints: slackWebhookPath,
        })
      : null;
  const clientOptions = resolveSlackWebClientOptions();
  const app = new App(
    slackMode === "socket"
      ? {
          token: botToken,
          appToken,
          socketMode: true,
          clientOptions,
        }
      : {
          token: botToken,
          receiver: receiver ?? undefined,
          clientOptions,
        },
  );
  const slackHttpHandler =
    slackMode === "http" && receiver
      ? async (req: IncomingMessage, res: ServerResponse) => {
          // Buffer the raw body so we can verify the HMAC signature before
          // forwarding to Bolt's receiver. This is the canonical approach
          // described at https://api.slack.com/authentication/verifying-requests-from-slack
          //
          // We enforce a body size limit manually here instead of using
          // installRequestBodyLimitGuard so that we control the buffer before
          // signature verification.
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for await (const chunk of req as AsyncIterable<Buffer>) {
            totalBytes += chunk.length;
            if (totalBytes > SLACK_WEBHOOK_MAX_BODY_BYTES) {
              res.writeHead(413, { "Content-Type": "text/plain" });
              res.end("Request body too large");
              return;
            }
            chunks.push(chunk);
          }
          const rawBody = Buffer.concat(chunks);

          // Full HMAC-SHA256 verification. Rejects forged, tampered, or
          // replayed requests before any business logic runs.
          // CWE-345: Insufficient Verification of Data Authenticity
          const verification = verifySlackRequestSignature({
            signingSecret: signingSecret ?? "",
            body: rawBody.toString("utf-8"),
            timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
            signature: req.headers["x-slack-signature"] as string | undefined,
          });
          if (!verification.ok) {
            res.writeHead(verification.statusCode, { "Content-Type": "text/plain" });
            res.end(verification.reason);
            return;
          }

          // Re-wrap the already-consumed body as a Readable so Bolt's
          // HTTPReceiver can process it normally. Bolt will re-verify the
          // signature against the same body — this is acceptable defence-in-depth.
          const bodyReadable = Readable.from(rawBody) as unknown as IncomingMessage;
          Object.assign(bodyReadable, {
            headers: req.headers,
            method: req.method,
            url: req.url,
            socket: req.socket,
            connection: req.socket,
            httpVersion: req.httpVersion,
            httpVersionMajor: req.httpVersionMajor,
            httpVersionMinor: req.httpVersionMinor,
          });

          try {
            await Promise.resolve(receiver.requestListener(bodyReadable, res));
          } catch {
            // Errors surfaced by Bolt after our verification have already been
            // authenticated; rethrow so the gateway can log them.
            throw new Error("Slack receiver error after signature verification");
          }
        }
      : null;
  let unregisterHttpHandler: (() => void) | null = null;

  let botUserId = "";
  let teamId = "";
  let apiAppId = "";
  const expectedApiAppIdFromAppToken = parseApiAppIdFromAppToken(appToken);
  try {
    const auth = await app.client.auth.test({ token: botToken });
    botUserId = auth.user_id ?? "";
    teamId = auth.team_id ?? "";
    apiAppId = (auth as { api_app_id?: string }).api_app_id ?? "";
  } catch {
    // auth test failing is non-fatal; message handler falls back to regex mentions.
  }

  if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) {
    runtime.error?.(
      `slack token mismatch: bot token api_app_id=${apiAppId} but app token looks like api_app_id=${expectedApiAppIdFromAppToken}`,
    );
  }

  const ctx = createSlackMonitorContext({
    cfg,
    accountId: account.accountId,
    botToken,
    app,
    runtime,
    botUserId,
    teamId,
    apiAppId,
    historyLimit,
    sessionScope,
    mainKey,
    dmEnabled,
    dmPolicy,
    allowFrom,
    groupDmEnabled,
    groupDmChannels,
    defaultRequireMention: slackCfg.requireMention,
    channelsConfig,
    groupPolicy,
    useAccessGroups,
    reactionMode,
    reactionAllowlist,
    replyToMode,
    threadHistoryScope,
    threadInheritParent,
    slashCommand,
    textLimit,
    ackReactionScope,
    mediaMaxBytes,
    removeAckAfterReply,
  });

  const handleSlackMessage = createSlackMessageHandler({ ctx, account });

  registerSlackMonitorEvents({ ctx, account, handleSlackMessage });
  await registerSlackMonitorSlashCommands({ ctx, account });
  if (slackMode === "http" && slackHttpHandler) {
    unregisterHttpHandler = registerSlackHttpHandler({
      path: slackWebhookPath,
      handler: slackHttpHandler,
      signingSecret: signingSecret ?? "",
      log: runtime.log,
      accountId: account.accountId,
    });
  }

  if (resolveToken) {
    void (async () => {
      if (opts.abortSignal?.aborted) {
        return;
      }

      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        try {
          const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
          if (entries.length > 0) {
            const resolved = await resolveSlackChannelAllowlist({
              token: resolveToken,
              entries,
            });
            const nextChannels = { ...channelsConfig };
            const mapping: string[] = [];
            const unresolved: string[] = [];
            for (const entry of resolved) {
              const source = channelsConfig?.[entry.input];
              if (!source) {
                continue;
              }
              if (!entry.resolved || !entry.id) {
                unresolved.push(entry.input);
                continue;
              }
              mapping.push(`${entry.input}→${entry.id}${entry.archived ? " (archived)" : ""}`);
              const existing = nextChannels[entry.id] ?? {};
              nextChannels[entry.id] = { ...source, ...existing };
            }
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channels", mapping, unresolved, runtime);
          }
        } catch (err) {
          runtime.log?.(`slack channel resolve failed; using config entries. ${String(err)}`);
        }
      }

      const allowEntries =
        allowFrom?.filter((entry) => String(entry).trim() && String(entry).trim() !== "*") ?? [];
      if (allowEntries.length > 0) {
        try {
          const resolvedUsers = await resolveSlackUserAllowlist({
            token: resolveToken,
            entries: allowEntries.map((entry) => String(entry)),
          });
          const { mapping, unresolved, additions } = buildAllowlistResolutionSummary(
            resolvedUsers,
            {
              formatResolved: (entry) => {
                const note = (entry as { note?: string }).note
                  ? ` (${(entry as { note?: string }).note})`
                  : "";
                return `${entry.input}→${entry.id}${note}`;
              },
            },
          );
          allowFrom = mergeAllowlist({ existing: allowFrom, additions });
          ctx.allowFrom = normalizeAllowList(allowFrom);
          summarizeMapping("slack users", mapping, unresolved, runtime);
        } catch (err) {
          runtime.log?.(`slack user resolve failed; using config entries. ${String(err)}`);
        }
      }

      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        const userEntries = new Set<string>();
        for (const channel of Object.values(channelsConfig)) {
          addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
        }

        if (userEntries.size > 0) {
          try {
            const resolvedUsers = await resolveSlackUserAllowlist({
              token: resolveToken,
              entries: Array.from(userEntries),
            });
            const { resolvedMap, mapping, unresolved } =
              buildAllowlistResolutionSummary(resolvedUsers);

            const nextChannels = patchAllowlistUsersInConfigEntries({
              entries: channelsConfig,
              resolvedMap,
            });
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channel users", mapping, unresolved, runtime);
          } catch (err) {
            runtime.log?.(
              `slack channel user resolve failed; using config entries. ${String(err)}`,
            );
          }
        }
      }
    })();
  }

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted && slackMode === "socket") {
      void app.stop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

  try {
    if (slackMode === "socket") {
      await app.start();
      runtime.log?.("slack socket mode connected");
    } else {
      runtime.log?.(`slack http mode listening at ${slackWebhookPath}`);
    }
    if (opts.abortSignal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      opts.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  } finally {
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    unregisterHttpHandler?.();
    await app.stop().catch(() => undefined);
  }
}
