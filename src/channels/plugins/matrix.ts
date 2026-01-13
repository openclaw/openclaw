import { chunkMarkdownText } from "../../auto-reply/chunk.js";
import type { MatrixConfig } from "../../config/types.js";
import {
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
} from "../../matrix/accounts.js";
import { probeMatrix } from "../../matrix/probe.js";
import { sendMessageMatrix } from "../../matrix/send.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../routing/session-key.js";
import { getChatChannelMeta } from "../registry.js";
import { formatPairingApproveHint } from "./helpers.js";
import { matrixOnboardingAdapter } from "./onboarding/matrix.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";
import type { ChannelPlugin } from "./types.js";

const meta = getChatChannelMeta("matrix");

export type ResolvedMatrixAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: {
    homeserver?: string;
    userId?: string;
    accessToken?: string;
    password?: string;
    dmPolicy?: string;
    allowFrom?: Array<string | number>;
    mediaMaxMb?: number;
    groupPolicy?: string;
  };
};

function clean(value?: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveMatrixCredentialValues(
  cfg: { matrix?: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env,
) {
  const matrixConfig = (cfg.matrix ?? {}) as Record<string, unknown>;
  return {
    matrixConfig,
    homeserver: clean(env.MATRIX_HOMESERVER) || clean(matrixConfig.homeserver),
    userId: clean(env.MATRIX_USER_ID) || clean(matrixConfig.userId),
    accessToken:
      clean(env.MATRIX_ACCESS_TOKEN) || clean(matrixConfig.accessToken),
    password: clean(env.MATRIX_PASSWORD) || clean(matrixConfig.password),
  };
}

function resolveMatrixAccount(params: {
  cfg: { matrix?: Record<string, unknown> };
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const cfg = params.cfg;
  const resolved = resolveMatrixCredentialValues(cfg);
  const matrixConfig = resolved.matrixConfig;
  const enabled = matrixConfig.enabled !== false;
  const configured = Boolean(
    resolved.homeserver &&
      resolved.userId &&
      (resolved.accessToken || resolved.password),
  );
  return {
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
    name: matrixConfig.name as string | undefined,
    enabled,
    configured,
    config: {
      homeserver: resolved.homeserver || undefined,
      userId: resolved.userId || undefined,
      accessToken: resolved.accessToken || undefined,
      password: resolved.password || undefined,
      dmPolicy: (matrixConfig.dm as Record<string, unknown> | undefined)
        ?.policy as string | undefined,
      allowFrom: (matrixConfig.dm as Record<string, unknown> | undefined)
        ?.allowFrom as Array<string | number> | undefined,
      mediaMaxMb: matrixConfig.mediaMaxMb as number | undefined,
      groupPolicy: matrixConfig.groupPolicy as string | undefined,
    },
  };
}

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  id: "matrix",
  meta: {
    ...meta,
  },
  onboarding: matrixOnboardingAdapter,
  pairing: {
    idLabel: "matrixUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^matrix:/i, ""),
    notifyApproval: async ({ id }) => {
      await sendMessageMatrix(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    polls: true,
    reactions: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["matrix"] },
  config: {
    listAccountIds: (cfg) => listMatrixAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveMatrixAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMatrixAccountId(cfg),
    setAccountEnabled: ({ cfg, enabled }) => {
      const base = (cfg.matrix as Record<string, unknown> | undefined) ?? {};
      return {
        ...cfg,
        matrix: {
          ...base,
          enabled,
        },
      };
    },
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg };
      delete next.matrix;
      return next;
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      homeserver: account.config.homeserver,
    }),
    resolveAllowFrom: ({ cfg }) => {
      const matrixDm = (cfg.matrix as Record<string, unknown> | undefined)
        ?.dm as Record<string, unknown> | undefined;
      const raw = matrixDm?.allowFrom as Array<string | number> | undefined;
      return raw?.map((entry) => String(entry)) ?? [];
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^matrix:/i, ""))
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => {
      const basePath = "matrix.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dm.policy`,
        allowFromPath: `${basePath}dm.`,
        approveHint: formatPairingApproveHint("matrix"),
      };
    },
    collectWarnings: ({ account }) => {
      const groupPolicy = account.config.groupPolicy ?? "disabled";
      if (groupPolicy !== "open") return [];
      return [
        `- Matrix rooms: groupPolicy="open" allows any member to trigger the bot. Set matrix.groupPolicy="allowlist" + matrix.rooms to restrict.`,
      ];
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, name }) => {
      const trimmed = name?.trim();
      if (!trimmed) return cfg;
      const base = (cfg.matrix ?? {}) as MatrixConfig;
      return {
        ...cfg,
        matrix: {
          ...base,
          name: trimmed,
        },
      };
    },
    validateInput: ({ input }) => {
      if (input.useEnv) return null;
      if (!input.homeserver?.trim()) {
        return "Matrix requires --homeserver (or --use-env).";
      }
      if (!input.userId?.trim()) {
        return "Matrix requires --user-id (or --use-env).";
      }
      if (!input.accessToken?.trim() && !input.password?.trim()) {
        return "Matrix requires --access-token or --password (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const base = (cfg.matrix ?? {}) as MatrixConfig;
      const next: MatrixConfig = {
        ...base,
        enabled: true,
      };
      if (input.homeserver?.trim()) next.homeserver = input.homeserver.trim();
      if (input.userId?.trim()) next.userId = input.userId.trim();
      if (input.accessToken?.trim()) {
        next.accessToken = input.accessToken.trim();
      }
      if (input.password?.trim()) next.password = input.password.trim();
      return {
        ...cfg,
        matrix: next,
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkMarkdownText,
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Matrix requires --to <room:ID|#alias|@user:server>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text }) => {
      const result = await sendMessageMatrix(to, text);
      return { channel: "matrix", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl }) => {
      const result = await sendMessageMatrix(to, text, { mediaUrl });
      return { channel: "matrix", ...result };
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
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError =
          typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "matrix",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const homeserver = account.config.homeserver;
      const accessToken = account.config.accessToken;
      if (!homeserver || !accessToken) {
        return {
          ok: false,
          error: "Matrix not configured",
          elapsedMs: 0,
        };
      }
      return probeMatrix({
        homeserver,
        accessToken,
        userId: account.config.userId,
        timeoutMs: timeoutMs ?? 10000,
      });
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({ accountId: account.accountId });
      ctx.log?.info(`[${account.accountId}] starting Matrix provider`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      const { monitorMatrixProvider } = await import("../../matrix/index.js");
      return monitorMatrixProvider({
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
      });
    },
  },
};
