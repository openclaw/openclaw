/**
 * Zalo channel plugin
 * @see https://bot.zaloplatforms.com/docs
 */

import { chunkMarkdownText } from "../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../globals.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../routing/session-key.js";
import {
  listZaloAccountIds,
  type ResolvedZaloAccount,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
} from "../../zalo/accounts.js";
import { probeZalo } from "../../zalo/probe.js";
import { sendMessageZalo } from "../../zalo/send.js";
import { getChatChannelMeta } from "../registry.js";
import { zaloMessageActions } from "./actions/zalo.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "./config-helpers.js";
import { formatPairingApproveHint } from "./helpers.js";
import { zaloOnboardingAdapter } from "./onboarding/zalo.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";
import {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "./setup-helpers.js";
import { collectZaloStatusIssues } from "./status-issues/zalo.js";
import type { ChannelPlugin } from "./types.js";

const meta = getChatChannelMeta("zalo");

/**
 * Normalize a Zalo messaging target (strip prefixes like zalo: or zl:)
 */
function normalizeZaloMessagingTarget(raw: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  // Strip zalo: or zl: prefix
  return trimmed.replace(/^(zalo|zl):/i, "");
}

export const zaloPlugin: ChannelPlugin<ResolvedZaloAccount> = {
  id: "zalo",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  onboarding: zaloOnboardingAdapter,
  pairing: {
    idLabel: "zaloUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(zalo|zl):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveZaloAccount({ cfg });
      if (!account.token) throw new Error("Zalo token not configured");
      await sendMessageZalo(id, PAIRING_APPROVED_MESSAGE, {
        token: account.token,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct"], // Groups "coming soon" per Zalo docs
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true, // 2000 char limit makes streaming less useful
  },
  reload: { configPrefixes: ["channels.zalo"] },
  config: {
    listAccountIds: (cfg) => listZaloAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveZaloAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZaloAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "zalo",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "zalo",
        accountId,
        clearBaseFields: ["botToken", "tokenFile", "name"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZaloAccount({ cfg, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(zalo|zl):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId =
        accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        cfg.channels?.zalo?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.zalo.accounts.${resolvedAccountId}.`
        : "channels.zalo.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zalo"),
        normalizeEntry: (raw) => raw.replace(/^(zalo|zl):/i, ""),
      };
    },
    collectWarnings: ({ account }) => {
      const groupPolicy = account.config.groupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- Zalo: groupPolicy="open" allows any group to trigger. Set channels.zalo.groupPolicy="allowlist" to restrict.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: () => true, // Default to requiring mention in groups
  },
  threading: {
    resolveReplyToMode: () => "off", // Zalo doesn't support reply threading
  },
  actions: zaloMessageActions,
  messaging: {
    normalizeTarget: normalizeZaloMessagingTarget,
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "zalo",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "ZALO_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Zalo requires --token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "zalo",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "zalo",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            zalo: {
              ...next.channels?.zalo,
              enabled: true,
              ...(input.useEnv
                ? {}
                : input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          zalo: {
            ...next.channels?.zalo,
            enabled: true,
            accounts: {
              ...next.channels?.zalo?.accounts,
              [accountId]: {
                ...next.channels?.zalo?.accounts?.[accountId],
                enabled: true,
                ...(input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkMarkdownText,
    textChunkLimit: 2000, // Zalo's message limit
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Zalo requires --to <chatId>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId }) => {
      const result = await sendMessageZalo(to, text, {
        verbose: false,
        accountId: accountId ?? undefined,
      });
      return {
        channel: "zalo",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const result = await sendMessageZalo(to, text, {
        verbose: false,
        mediaUrl,
        accountId: accountId ?? undefined,
      });
      return {
        channel: "zalo",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectZaloStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeZalo(account.token, timeoutMs),
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.token?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: account.config.webhookUrl ? "webhook" : "polling",
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let zaloBotLabel = "";
      try {
        const probe = await probeZalo(token, 2500);
        const name = probe.ok ? probe.bot?.name?.trim() : null;
        if (name) zaloBotLabel = ` (${name})`;
        ctx.setStatus({
          accountId: account.accountId,
          bot: probe.bot,
        });
      } catch (err) {
        if (shouldLogVerbose()) {
          ctx.log?.debug?.(
            `[${account.accountId}] bot probe failed: ${String(err)}`,
          );
        }
      }
      ctx.log?.info(`[${account.accountId}] starting provider${zaloBotLabel}`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      const { monitorZaloProvider } = await import("../../zalo/monitor.js");
      return monitorZaloProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        useWebhook: Boolean(account.config.webhookUrl),
        webhookUrl: account.config.webhookUrl,
        webhookSecret: account.config.webhookSecret,
        webhookPath: account.config.webhookPath,
      });
    },
  },
};
