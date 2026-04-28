import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveApprovalApprovers } from "../../plugin-sdk/approval-approvers.js";
import {
  createApproverRestrictedNativeApprovalAdapter,
  createResolvedApproverActionAuthAdapter,
} from "../../plugin-sdk/approval-runtime.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  extractApprovalIdFromReplyBody,
  handleApproveCommand,
  parseApproveCommand,
} from "./commands-approve.js";
import type { HandleCommandsParams } from "./commands-types.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

function normalizeDiscordDirectApproverId(value: string | number): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(discord|user|pk):/i, "")
    .replace(/^<@!?(\d+)>$/, "$1")
    .toLowerCase();
  return normalized || undefined;
}

function getDiscordExecApprovalApproversForTests(params: { cfg: OpenClawConfig }): string[] {
  const discord = params.cfg.channels?.discord;
  return resolveApprovalApprovers({
    explicit: discord?.execApprovals?.approvers,
    allowFrom: discord?.allowFrom,
    extraAllowFrom: discord?.dm?.allowFrom,
    defaultTo: discord?.defaultTo,
    normalizeApprover: normalizeDiscordDirectApproverId,
    normalizeDefaultTo: (value) => normalizeDiscordDirectApproverId(value),
  });
}

const discordNativeApprovalAdapterForTests = createApproverRestrictedNativeApprovalAdapter({
  channel: "discord",
  channelLabel: "Discord",
  listAccountIds: () => [DEFAULT_ACCOUNT_ID],
  hasApprovers: ({ cfg }) => getDiscordExecApprovalApproversForTests({ cfg }).length > 0,
  isExecAuthorizedSender: ({ cfg, senderId }) => {
    const normalizedSenderId =
      senderId === undefined || senderId === null
        ? undefined
        : normalizeDiscordDirectApproverId(senderId);
    return Boolean(
      normalizedSenderId &&
      getDiscordExecApprovalApproversForTests({ cfg }).includes(normalizedSenderId),
    );
  },
  isNativeDeliveryEnabled: ({ cfg }) =>
    Boolean(cfg.channels?.discord?.execApprovals?.enabled) &&
    getDiscordExecApprovalApproversForTests({ cfg }).length > 0,
  resolveNativeDeliveryMode: ({ cfg }) => cfg.channels?.discord?.execApprovals?.target ?? "dm",
});

const discordApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "discord",
    label: "Discord",
    docsPath: "/channels/discord",
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      reactions: true,
      threads: true,
      nativeCommands: true,
    },
  }),
  approvalCapability: {
    authorizeActorAction: discordNativeApprovalAdapterForTests.auth.authorizeActorAction,
    getActionAvailabilityState:
      discordNativeApprovalAdapterForTests.auth.getActionAvailabilityState,
  },
};

const slackApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "slack",
    label: "Slack",
    docsPath: "/channels/slack",
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      reactions: true,
      threads: true,
      nativeCommands: true,
    },
  }),
};

const whatsappApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "whatsapp",
    label: "WhatsApp",
    docsPath: "/channels/whatsapp",
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      nativeCommands: true,
    },
  }),
};

const signalApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "signal",
    label: "Signal",
    docsPath: "/channels/signal",
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: true,
      media: true,
      nativeCommands: true,
    },
  }),
  approvalCapability: createResolvedApproverActionAuthAdapter({
    channelLabel: "Signal",
    resolveApprovers: ({ cfg, accountId }) => {
      const scopedSignal = accountId ? cfg.channels?.signal?.accounts?.[accountId] : undefined;
      const signal = scopedSignal ?? cfg.channels?.signal;
      return resolveApprovalApprovers({
        allowFrom: signal?.allowFrom,
        defaultTo: signal?.defaultTo,
        normalizeApprover: (value) => String(value).trim() || undefined,
      });
    },
  }),
};

type TelegramTestAccountConfig = {
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  execApprovals?: {
    enabled?: boolean;
    approvers?: string[];
    target?: "dm" | "channel" | "both";
  };
};

type TelegramTestSectionConfig = TelegramTestAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, TelegramTestAccountConfig>;
};

function listConfiguredTelegramAccountIds(cfg: OpenClawConfig): string[] {
  const channel = cfg.channels?.telegram as TelegramTestSectionConfig | undefined;
  const accountIds = Object.keys(channel?.accounts ?? {});
  if (accountIds.length > 0) {
    return accountIds;
  }
  if (!channel) {
    return [];
  }
  const { accounts: _accounts, defaultAccount: _defaultAccount, ...base } = channel;
  return Object.values(base).some((value) => value !== undefined) ? [DEFAULT_ACCOUNT_ID] : [];
}

function resolveTelegramTestAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TelegramTestAccountConfig {
  const resolvedAccountId = normalizeAccountId(accountId);
  const channel = cfg.channels?.telegram as TelegramTestSectionConfig | undefined;
  const scoped = channel?.accounts?.[resolvedAccountId];
  const base = resolvedAccountId === DEFAULT_ACCOUNT_ID ? channel : undefined;
  return {
    ...base,
    ...scoped,
    enabled:
      typeof scoped?.enabled === "boolean"
        ? scoped.enabled
        : typeof channel?.enabled === "boolean"
          ? channel.enabled
          : true,
  };
}

function stripTelegramInternalPrefixes(value: string): string {
  let trimmed = value.trim();
  let strippedTelegramPrefix = false;
  while (true) {
    const next = (() => {
      if (/^(telegram|tg):/i.test(trimmed)) {
        strippedTelegramPrefix = true;
        return trimmed.replace(/^(telegram|tg):/i, "").trim();
      }
      if (strippedTelegramPrefix && /^group:/i.test(trimmed)) {
        return trimmed.replace(/^group:/i, "").trim();
      }
      return trimmed;
    })();
    if (next === trimmed) {
      return trimmed;
    }
    trimmed = next;
  }
}

function normalizeTelegramDirectApproverId(value: string | number): string | undefined {
  const normalized = stripTelegramInternalPrefixes(String(value));
  if (!normalized || normalized.startsWith("-")) {
    return undefined;
  }
  return normalized;
}

function getTelegramExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveTelegramTestAccount(params.cfg, params.accountId);
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers,
    allowFrom: account.allowFrom,
    normalizeApprover: normalizeTelegramDirectApproverId,
  });
}

function isTelegramExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  const execApprovals = params.cfg.approvals?.exec;
  if (
    !senderId ||
    execApprovals?.enabled !== true ||
    (execApprovals.mode !== "targets" && execApprovals.mode !== "both")
  ) {
    return false;
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  return (execApprovals.targets ?? []).some((target) => {
    if (target.channel?.trim().toLowerCase() !== "telegram") {
      return false;
    }
    if (accountId && target.accountId && normalizeAccountId(target.accountId) !== accountId) {
      return false;
    }
    const to = target.to ? normalizeTelegramDirectApproverId(target.to) : undefined;
    return Boolean(to && to === senderId);
  });
}

function isTelegramExecApprovalAuthorizedSender(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId ? normalizeTelegramDirectApproverId(params.senderId) : undefined;
  if (!senderId) {
    return false;
  }
  return (
    getTelegramExecApprovalApprovers(params).includes(senderId) ||
    isTelegramExecApprovalTargetRecipient(params)
  );
}

function isTelegramExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveTelegramTestAccount(params.cfg, params.accountId).execApprovals;
  return Boolean(config?.enabled && getTelegramExecApprovalApprovers(params).length > 0);
}

function resolveTelegramExecApprovalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): "dm" | "channel" | "both" {
  return resolveTelegramTestAccount(params.cfg, params.accountId).execApprovals?.target ?? "dm";
}

const telegramNativeApprovalAdapter = createApproverRestrictedNativeApprovalAdapter({
  channel: "telegram",
  channelLabel: "Telegram",
  listAccountIds: listConfiguredTelegramAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getTelegramExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: isTelegramExecApprovalAuthorizedSender,
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) => {
    const normalizedSenderId = senderId?.trim();
    return Boolean(
      normalizedSenderId &&
      getTelegramExecApprovalApprovers({ cfg, accountId }).includes(normalizedSenderId),
    );
  },
  isNativeDeliveryEnabled: isTelegramExecApprovalClientEnabled,
  resolveNativeDeliveryMode: resolveTelegramExecApprovalTarget,
  requireMatchingTurnSourceChannel: true,
});

const telegramApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      polls: true,
      nativeCommands: true,
      blockStreaming: true,
    },
    config: {
      listAccountIds: listConfiguredTelegramAccountIds,
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        resolveTelegramTestAccount(cfg, accountId),
      defaultAccountId: (cfg: OpenClawConfig) =>
        (cfg.channels?.telegram as TelegramTestSectionConfig | undefined)?.defaultAccount ??
        DEFAULT_ACCOUNT_ID,
    },
  }),
  approvalCapability: {
    authorizeActorAction: telegramNativeApprovalAdapter.auth.authorizeActorAction,
    getActionAvailabilityState: telegramNativeApprovalAdapter.auth.getActionAvailabilityState,
    resolveApproveCommandBehavior: ({ cfg, accountId, senderId, approvalKind }) => {
      if (approvalKind !== "exec") {
        return undefined;
      }
      if (isTelegramExecApprovalClientEnabled({ cfg, accountId })) {
        return undefined;
      }
      if (isTelegramExecApprovalTargetRecipient({ cfg, accountId, senderId })) {
        return undefined;
      }
      if (
        isTelegramExecApprovalAuthorizedSender({ cfg, accountId, senderId }) &&
        !getTelegramExecApprovalApprovers({ cfg, accountId }).includes(senderId?.trim() ?? "")
      ) {
        return undefined;
      }
      return {
        kind: "reply",
        text: "❌ Telegram exec approvals are not enabled for this bot account.",
      } as const;
    },
  },
};

function setApprovePluginRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "discord", plugin: discordApproveTestPlugin, source: "test" },
      { pluginId: "slack", plugin: slackApproveTestPlugin, source: "test" },
      { pluginId: "whatsapp", plugin: whatsappApproveTestPlugin, source: "test" },
      { pluginId: "signal", plugin: signalApproveTestPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramApproveTestPlugin, source: "test" },
    ]),
  );
}

function buildApproveParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
  ctxOverrides?: {
    Provider?: string;
    Surface?: string;
    SenderId?: string;
    GatewayClientScopes?: string[];
    AccountId?: string;
    ReplyToBody?: string;
  },
): HandleCommandsParams {
  const provider = ctxOverrides?.Provider ?? "whatsapp";
  return {
    cfg,
    ctx: {
      Provider: provider,
      Surface: ctxOverrides?.Surface ?? provider,
      CommandSource: "text",
      SenderId: ctxOverrides?.SenderId,
      GatewayClientScopes: ctxOverrides?.GatewayClientScopes,
      AccountId: ctxOverrides?.AccountId,
      ReplyToBody: ctxOverrides?.ReplyToBody,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: ctxOverrides?.SenderId ?? "owner",
      channel: provider,
      channelId: provider,
    },
  } as unknown as HandleCommandsParams;
}

describe("parseApproveCommand", () => {
  it("returns null for non-approve commands", () => {
    expect(parseApproveCommand("/help")).toBeNull();
    expect(parseApproveCommand("not a command")).toBeNull();
  });

  it("returns usage error for empty body", () => {
    const result = parseApproveCommand("/approve");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Usage: /approve") });
  });

  it("rejects foreign bot mention", () => {
    const result = parseApproveCommand("/approve@otherbot abc allow-once");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("different Telegram bot") });
  });

  it("parses `/approve <id> <decision>` (id-first form)", () => {
    expect(parseApproveCommand("/approve abc123 allow-once")).toEqual({
      ok: true,
      id: "abc123",
      decision: "allow-once",
    });
  });

  it("parses `/approve <decision> <id>` (decision-first form)", () => {
    expect(parseApproveCommand("/approve allow-once abc123")).toEqual({
      ok: true,
      id: "abc123",
      decision: "allow-once",
    });
  });

  it("parses single-token `/approve <decision>` with id=null (reply-to-message form)", () => {
    for (const decision of [
      "allow-once",
      "allow-always",
      "deny",
      "allow",
      "once",
      "always",
      "reject",
      "block",
    ]) {
      const result = parseApproveCommand(`/approve ${decision}`);
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.id).toBeNull();
      }
    }
  });

  it("rejects single-token form with an unknown decision", () => {
    const result = parseApproveCommand("/approve maybe");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Usage: /approve") });
  });

  it("rejects two-token form when neither token is a decision", () => {
    const result = parseApproveCommand("/approve abc xyz");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Usage: /approve") });
  });

  it("recognizes `approve` (no slash) for chat clients that strip it", () => {
    expect(parseApproveCommand("approve abc123 deny")).toEqual({
      ok: true,
      id: "abc123",
      decision: "deny",
    });
  });
});

describe("extractApprovalIdFromReplyBody", () => {
  it("returns null for empty/missing input", () => {
    expect(extractApprovalIdFromReplyBody(undefined)).toBeNull();
    expect(extractApprovalIdFromReplyBody(null)).toBeNull();
    expect(extractApprovalIdFromReplyBody("")).toBeNull();
  });

  it("extracts ID from a forwarded approval request body", () => {
    const body = [
      "🔒 Exec approval required",
      "ID: f0c7503f-1234-4567-89ab-cdef01234567",
      "Command: `echo hi`",
      "Reply with: /approve <id> allow-once|deny",
    ].join("\n");
    expect(extractApprovalIdFromReplyBody(body)).toBe("f0c7503f-1234-4567-89ab-cdef01234567");
  });

  it("matches the ID line case-insensitively (id:, ID:, Id:)", () => {
    expect(extractApprovalIdFromReplyBody("id: abc123")).toBe("abc123");
    expect(extractApprovalIdFromReplyBody("Id:\tdef456")).toBe("def456");
  });

  it("matches the first occurrence at line start (multiline)", () => {
    const body = "Header\nID: first-id\nID: second-id\n";
    expect(extractApprovalIdFromReplyBody(body)).toBe("first-id");
  });

  it("ignores non-anchored matches (e.g., 'this ID: foo' inline)", () => {
    expect(extractApprovalIdFromReplyBody("see this ID: foo")).toBeNull();
  });

  it("supports custom (non-UUID) ID formats", () => {
    expect(extractApprovalIdFromReplyBody("ID: req-1\nCommand: ...")).toBe("req-1");
    expect(extractApprovalIdFromReplyBody("ID: plugin:abc.def\n")).toBe("plugin:abc.def");
  });
});

describe("handleApproveCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApprovePluginRegistry();
  });

  function createTelegramApproveCfg(
    execApprovals: {
      enabled: true;
      approvers: string[];
      target: "dm";
    } | null = { enabled: true, approvers: ["123"], target: "dm" },
  ): OpenClawConfig {
    return {
      commands: { text: true },
      channels: {
        telegram: {
          allowFrom: ["*"],
          ...(execApprovals ? { execApprovals } : {}),
        },
      },
    } as OpenClawConfig;
  }

  function createDiscordApproveCfg(
    execApprovals: {
      enabled: boolean;
      approvers: string[];
      target: "dm" | "channel" | "both";
    } | null = { enabled: true, approvers: ["123"], target: "channel" },
  ): OpenClawConfig {
    return {
      commands: { text: true },
      channels: {
        discord: {
          allowFrom: ["*"],
          ...(execApprovals ? { execApprovals } : {}),
        },
      },
    } as OpenClawConfig;
  }

  it("rejects invalid usage", async () => {
    const result = await handleApproveCommand(
      buildApproveParams("/approve", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Usage: /approve");
  });

  it("submits approval", async () => {
    callGatewayMock.mockResolvedValue({ ok: true });
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve abc allow-once",
        {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        { SenderId: "123" },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc", decision: "allow-once" },
      }),
    );
  });

  it("extracts approval id from replied-to message body when only decision is provided", async () => {
    callGatewayMock.mockResolvedValue({ ok: true });
    const replyBody = [
      "🔒 Exec approval required",
      "ID: f0c7503f-aaaa-bbbb-cccc-ddddeeeeffff",
      "Command: `ls`",
    ].join("\n");
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve allow-once",
        {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        { SenderId: "123", ReplyToBody: replyBody },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(result?.reply?.text).toContain("f0c7503f-aaaa-bbbb-cccc-ddddeeeeffff");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: {
          id: "f0c7503f-aaaa-bbbb-cccc-ddddeeeeffff",
          decision: "allow-once",
        },
      }),
    );
  });

  it("returns a helpful error when single-token /approve is used without a reply body", async () => {
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve allow-once",
        {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        { SenderId: "123" },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Could not extract approval ID from replied message");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns a helpful error when reply body has no ID line", async () => {
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve deny",
        {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        { SenderId: "123", ReplyToBody: "Hello, this is just a normal message." },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Could not extract approval ID from replied message");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("routes plugin-prefixed IDs extracted from a reply body to plugin.approval.resolve", async () => {
    callGatewayMock.mockResolvedValue({ ok: true });
    const replyBody = ["🛠️ Plugin approval required", "ID: plugin:my-tool-9d2"].join("\n");
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve allow-once",
        createDiscordApproveCfg({ enabled: true, approvers: ["123"], target: "channel" }),
        {
          Provider: "discord",
          Surface: "discord",
          SenderId: "123",
          ReplyToBody: replyBody,
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("plugin:my-tool-9d2");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugin.approval.resolve",
        params: { id: "plugin:my-tool-9d2", decision: "allow-once" },
      }),
    );
  });

  it("accepts bare approve text for Slack-style manual approvals", async () => {
    callGatewayMock.mockResolvedValue({ ok: true });
    const result = await handleApproveCommand(
      buildApproveParams(
        "approve abc allow-once",
        {
          commands: { text: true },
          channels: { slack: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        {
          Provider: "slack",
          Surface: "slack",
          SenderId: "U123",
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc", decision: "allow-once" },
      }),
    );
  });

  it("accepts Telegram /approve from configured approvers even when chat access is otherwise blocked", async () => {
    const params = buildApproveParams("/approve abc12345 allow-once", createTelegramApproveCfg(), {
      Provider: "telegram",
      Surface: "telegram",
      SenderId: "123",
    });
    params.command.isAuthorizedSender = false;
    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc12345", decision: "allow-once" },
      }),
    );
  });

  it("honors the configured default account for omitted-account /approve auth", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: telegramApproveTestPlugin,
          source: "test",
        },
      ]),
    );
    callGatewayMock.mockResolvedValue({ ok: true });
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        commands: { text: true },
        channels: {
          telegram: {
            defaultAccount: "work",
            allowFrom: ["*"],
            accounts: {
              work: {
                execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
              },
            },
          },
        },
      } as OpenClawConfig,
      {
        Provider: "telegram",
        Surface: "telegram",
        SenderId: "123",
        AccountId: undefined,
      },
    );
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc12345", decision: "allow-once" },
      }),
    );
  });

  it("accepts Signal /approve from configured approvers even when chat access is otherwise blocked", async () => {
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        commands: { text: true },
        channels: {
          signal: {
            allowFrom: ["+15551230000"],
          },
        },
      } as OpenClawConfig,
      {
        Provider: "signal",
        Surface: "signal",
        SenderId: "+15551230000",
      },
    );
    params.command.isAuthorizedSender = false;
    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc12345", decision: "allow-once" },
      }),
    );
  });

  it("does not treat implicit default approval auth as a bypass for unauthorized senders", async () => {
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        commands: { text: true },
      } as OpenClawConfig,
      {
        Provider: "webchat",
        Surface: "webchat",
        SenderId: "123",
      },
    );
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not treat implicit same-chat approval auth as a bypass for unauthorized senders", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
            approvalCapability: {
              authorizeActorAction: () => ({ authorized: true }),
              getActionAvailabilityState: () => ({ kind: "disabled" }),
            },
          },
          source: "test",
        },
      ]),
    );
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        commands: { text: true },
        channels: { slack: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      {
        Provider: "slack",
        Surface: "slack",
        SenderId: "U123",
      },
    );
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not allow empty helper approvers to bypass unauthorized sender checks", async () => {
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        commands: { text: true },
        channels: {
          signal: {
            allowFrom: [],
          },
        },
      } as OpenClawConfig,
      {
        Provider: "signal",
        Surface: "signal",
        SenderId: "+15551239999",
      },
    );
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("keeps same-chat /approve available to authorized senders when helper approvers are empty", async () => {
    callGatewayMock.mockResolvedValue({ ok: true });
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        commands: { text: true },
        channels: {
          signal: {
            allowFrom: [],
          },
        },
      } as OpenClawConfig,
      {
        Provider: "signal",
        Surface: "signal",
        SenderId: "+15551239999",
      },
    );
    params.command.isAuthorizedSender = true;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc12345", decision: "allow-once" },
      }),
    );
  });

  it("accepts Telegram /approve from exec target recipients when native approvals are disabled", async () => {
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        commands: { text: true },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "telegram", to: "123" }],
          },
        },
        channels: {
          telegram: {
            allowFrom: ["*"],
          },
        },
      } as OpenClawConfig,
      {
        Provider: "telegram",
        Surface: "telegram",
        SenderId: "123",
      },
    );
    params.command.isAuthorizedSender = false;
    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc12345", decision: "allow-once" },
      }),
    );
  });

  it("requires configured Discord approvers for exec approvals", async () => {
    for (const testCase of [
      {
        name: "discord no approver policy",
        cfg: createDiscordApproveCfg(null),
        senderId: "123",
        expectedText: "not authorized to approve",
        expectedGatewayCalls: 0,
      },
      {
        name: "discord non approver",
        cfg: createDiscordApproveCfg({ enabled: true, approvers: ["999"], target: "channel" }),
        senderId: "123",
        expectedText: "not authorized to approve",
        expectedGatewayCalls: 0,
      },
      {
        name: "discord approver with rich client disabled",
        cfg: createDiscordApproveCfg({ enabled: false, approvers: ["123"], target: "channel" }),
        senderId: "123",
        expectedText: "Approval allow-once submitted",
        expectedGatewayCalls: 1,
        expectedMethod: "exec.approval.resolve",
      },
      {
        name: "discord approver",
        cfg: createDiscordApproveCfg({ enabled: true, approvers: ["123"], target: "channel" }),
        senderId: "123",
        expectedText: "Approval allow-once submitted",
        expectedGatewayCalls: 1,
        expectedMethod: "exec.approval.resolve",
      },
    ] as const) {
      callGatewayMock.mockReset();
      if (testCase.expectedGatewayCalls > 0) {
        callGatewayMock.mockResolvedValue({ ok: true });
      }
      const result = await handleApproveCommand(
        buildApproveParams("/approve abc12345 allow-once", testCase.cfg, {
          Provider: "discord",
          Surface: "discord",
          SenderId: testCase.senderId,
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(callGatewayMock, testCase.name).toHaveBeenCalledTimes(testCase.expectedGatewayCalls);
      if ("expectedMethod" in testCase) {
        expect(callGatewayMock, testCase.name).toHaveBeenCalledWith(
          expect.objectContaining({
            method: testCase.expectedMethod,
            params: { id: "abc12345", decision: "allow-once" },
          }),
        );
      }
    }
  });

  it("rejects legacy unprefixed plugin approval fallback on Discord before exec fallback", async () => {
    for (const testCase of [
      {
        name: "discord legacy plugin approval with exec approvals disabled",
        cfg: createDiscordApproveCfg(null),
        senderId: "123",
      },
      {
        name: "discord legacy plugin approval for non approver",
        cfg: createDiscordApproveCfg({ enabled: true, approvers: ["999"], target: "channel" }),
        senderId: "123",
      },
    ] as const) {
      callGatewayMock.mockReset();
      callGatewayMock.mockResolvedValue({ ok: true });
      const result = await handleApproveCommand(
        buildApproveParams("/approve legacy-plugin-123 allow-once", testCase.cfg, {
          Provider: "discord",
          Surface: "discord",
          SenderId: testCase.senderId,
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain("not authorized to approve");
      expect(callGatewayMock, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("preserves legacy unprefixed plugin approval fallback on Discord", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("unknown or expired approval id"));
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve legacy-plugin-123 allow-once",
        createDiscordApproveCfg({ enabled: true, approvers: ["123"], target: "channel" }),
        {
          Provider: "discord",
          Surface: "discord",
          SenderId: "123",
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "plugin.approval.resolve",
        params: { id: "legacy-plugin-123", decision: "allow-once" },
      }),
    );
  });

  it("returns the underlying not-found error for plugin-only approval routing", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          plugin: {
            ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
            approvalCapability: {
              authorizeActorAction: ({ approvalKind }: { approvalKind: "exec" | "plugin" }) =>
                approvalKind === "plugin"
                  ? { authorized: true }
                  : {
                      authorized: false,
                      reason: "❌ You are not authorized to approve exec requests on Matrix.",
                    },
            },
          },
          source: "test",
        },
      ]),
    );
    callGatewayMock.mockRejectedValueOnce(new Error("unknown or expired approval id"));

    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve abc123 allow-once",
        {
          commands: { text: true },
          channels: { matrix: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        {
          Provider: "matrix",
          Surface: "matrix",
          SenderId: "123",
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Failed to submit approval");
    expect(result?.reply?.text).toContain("unknown or expired approval id");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugin.approval.resolve",
        params: { id: "abc123", decision: "allow-once" },
      }),
    );
  });

  it("requires configured Discord approvers for plugin approvals", async () => {
    for (const testCase of [
      {
        name: "discord plugin non approver",
        cfg: createDiscordApproveCfg({ enabled: false, approvers: ["999"], target: "channel" }),
        senderId: "123",
        expectedText: "not authorized to approve plugin requests",
        expectedGatewayCalls: 0,
      },
      {
        name: "discord plugin approver",
        cfg: createDiscordApproveCfg({ enabled: false, approvers: ["123"], target: "channel" }),
        senderId: "123",
        expectedText: "Approval allow-once submitted",
        expectedGatewayCalls: 1,
      },
    ] as const) {
      callGatewayMock.mockReset();
      if (testCase.expectedGatewayCalls > 0) {
        callGatewayMock.mockResolvedValue({ ok: true });
      }
      const result = await handleApproveCommand(
        buildApproveParams("/approve plugin:abc123 allow-once", testCase.cfg, {
          Provider: "discord",
          Surface: "discord",
          SenderId: testCase.senderId,
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(callGatewayMock, testCase.name).toHaveBeenCalledTimes(testCase.expectedGatewayCalls);
      if (testCase.expectedGatewayCalls > 0) {
        expect(callGatewayMock, testCase.name).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "plugin.approval.resolve",
            params: { id: "plugin:abc123", decision: "allow-once" },
          }),
        );
      }
    }
  });

  it("rejects unauthorized or invalid Telegram /approve variants", async () => {
    for (const testCase of [
      {
        name: "different bot mention",
        cfg: createTelegramApproveCfg(),
        commandBody: "/approve@otherbot abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        expectedText: "targets a different Telegram bot",
        expectGatewayCalls: 0,
      },
      {
        name: "unknown approval id",
        cfg: createTelegramApproveCfg(),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        setup: () => callGatewayMock.mockRejectedValue(new Error("unknown or expired approval id")),
        expectedText: "unknown or expired approval id",
        expectGatewayCalls: 2,
      },
      {
        name: "telegram disabled native delivery reports the channel-disabled message",
        cfg: createTelegramApproveCfg(null),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        expectedText: "Telegram exec approvals are not enabled",
        expectGatewayCalls: 0,
      },
      {
        name: "non approver",
        cfg: createTelegramApproveCfg({ enabled: true, approvers: ["999"], target: "dm" }),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        expectedText: "not authorized to approve",
        expectGatewayCalls: 0,
      },
    ] as const) {
      callGatewayMock.mockReset();
      testCase.setup?.();
      const result = await handleApproveCommand(
        buildApproveParams(testCase.commandBody, testCase.cfg, testCase.ctx),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(callGatewayMock, testCase.name).toHaveBeenCalledTimes(testCase.expectGatewayCalls);
    }
  });

  it("enforces gateway approval scopes", async () => {
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;
    for (const testCase of [
      {
        scopes: ["operator.write"],
        expectedText: "requires operator.approvals",
        expectedGatewayCalls: 0,
      },
      {
        scopes: ["operator.approvals"],
        expectedText: "Approval allow-once submitted",
        expectedGatewayCalls: 1,
      },
      {
        scopes: ["operator.admin"],
        expectedText: "Approval allow-once submitted",
        expectedGatewayCalls: 1,
      },
    ] as const) {
      callGatewayMock.mockReset();
      callGatewayMock.mockResolvedValue({ ok: true });
      const result = await handleApproveCommand(
        buildApproveParams("/approve abc allow-once", cfg, {
          Provider: "webchat",
          Surface: "webchat",
          GatewayClientScopes: [...testCase.scopes],
        }),
        true,
      );

      expect(result?.shouldContinue, String(testCase.scopes)).toBe(false);
      expect(result?.reply?.text, String(testCase.scopes)).toContain(testCase.expectedText);
      expect(callGatewayMock, String(testCase.scopes)).toHaveBeenCalledTimes(
        testCase.expectedGatewayCalls,
      );
      if (testCase.expectedGatewayCalls > 0) {
        expect(callGatewayMock, String(testCase.scopes)).toHaveBeenLastCalledWith(
          expect.objectContaining({
            method: "exec.approval.resolve",
            params: { id: "abc", decision: "allow-once" },
          }),
        );
      }
    }
  });
});
