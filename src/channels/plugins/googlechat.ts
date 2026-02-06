import {
  listGoogleChatAccountIds,
  type ResolvedGoogleChatAccount,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
} from "../../googlechat/accounts.js";
import { probeGoogleChat } from "../../googlechat/probe.js";
import {
  chunkGoogleChatText,
  sendGoogleChatMedia,
  sendGoogleChatText,
} from "../../googlechat/send.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { getChatProviderMeta } from "../registry.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "./config-helpers.js";
import { formatPairingApproveHint } from "./helpers.js";
import type { ProviderPlugin } from "./types.js";

const meta = getChatProviderMeta("googlechat");

export const googlechatPlugin: ProviderPlugin<ResolvedGoogleChatAccount> = {
  id: "googlechat",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "email",
    normalizeAllowEntry: (entry) => entry.toLowerCase().trim(),
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["googlechat"] },
  config: {
    listAccountIds: (cfg) => listGoogleChatAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveGoogleChatAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultGoogleChatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "googlechat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "googlechat",
        accountId,
        clearBaseFields: [
          "projectId",
          "subscriptionName",
          "credentialsPath",
          "name",
        ],
      }),
    isConfigured: (account) =>
      Boolean(account.projectId?.trim() && account.subscriptionName?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(
        account.projectId?.trim() && account.subscriptionName?.trim(),
      ),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveGoogleChatAccount({ cfg, accountId }).config.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const googlechat = (
        cfg as { googlechat?: { accounts?: Record<string, unknown> } }
      ).googlechat;
      const resolvedAccountId =
        accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(googlechat?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `googlechat.accounts.${resolvedAccountId}.`
        : "googlechat.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("googlechat"),
        normalizeEntry: (raw) => raw.toLowerCase().trim(),
      };
    },
  },
  threading: {
    resolveReplyToMode: () => "first",
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkGoogleChatText,
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Google Chat requires --to <spaceId>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, cfg, replyToId }) => {
      const account = resolveGoogleChatAccount({ cfg, accountId });
      const result = await sendGoogleChatText(to, text, {
        account,
        threadKey: replyToId ?? undefined,
      });
      return { provider: "googlechat", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg, replyToId }) => {
      const account = resolveGoogleChatAccount({ cfg, accountId });
      const result = await sendGoogleChatMedia(to, mediaUrl ?? "", {
        account,
        caption: text,
        threadKey: replyToId ?? undefined,
      });
      return { provider: "googlechat", ...result };
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
    buildProviderSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeGoogleChat(account, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(
        account.projectId?.trim() && account.subscriptionName?.trim(),
      );
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Google Chat provider`);

      // Lazy import to avoid circular deps
      const { monitorGoogleChatProvider } = await import(
        "../../googlechat/monitor.js"
      );

      return monitorGoogleChatProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
