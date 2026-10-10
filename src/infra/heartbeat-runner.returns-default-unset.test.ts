import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey, resolveMainSessionKey } from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import {
  writeConfigMachineState,
  deleteConfigMachineState,
} from "../state/config-machine-state-write.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  heartbeatTestConfig,
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
  seedSessionStore,
} from "./heartbeat-runner.test-utils.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatDeliveryTargetWithSessionRoute,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";
import { telegramMessagingForTest } from "./outbound/targets.test-helpers.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let testRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

let fixtureRoot = "";
let fixtureCount = 0;
let previousStateDir: string | undefined;

function normalizeWhatsAppTargetForTest(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^whatsapp:/i, "")
    .trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase().replace(/\s+/gu, "");
  if (/^\d+@g\.us$/u.test(lowered)) {
    return lowered;
  }
  const digits = trimmed.replace(/\D/gu, "");
  const normalized = digits ? `+${digits}` : "";
  return /^\+\d{7,15}$/u.test(normalized) ? normalized : null;
}

function isWhatsAppGroupJidForTest(raw: string): boolean {
  return /^\d+@g\.us$/u.test(raw.trim().toLowerCase());
}

const whatsappOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const sender = deps?.whatsapp as
      | ((
          to: string,
          text: string,
          options?: Record<string, unknown>,
        ) => Promise<{ messageId: string } & Record<string, unknown>>)
      | undefined;
    if (!sender) {
      throw new Error("missing whatsapp sender");
    }
    const result = await sender(to, text, {
      verbose: false,
      cfg,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "whatsapp",
      ...result,
    };
  },
};

function resolveWhatsAppTargetForTest(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
}) {
  const trimmed = params.to?.trim() ?? "";
  const allowList: string[] = [];
  let hasWildcard = false;
  for (const entry of params.allowFrom ?? []) {
    const raw = String(entry).trim();
    if (!raw) {
      continue;
    }
    if (raw === "*") {
      hasWildcard = true;
      continue;
    }
    const normalized = normalizeWhatsAppTargetForTest(raw);
    if (normalized) {
      allowList.push(normalized);
    }
  }
  const normalizedTarget = normalizeWhatsAppTargetForTest(trimmed);

  if (!normalizedTarget) {
    return {
      ok: false as const,
      error: new Error('Missing target for WhatsApp; expected "<E.164|group JID>".'),
    };
  }
  if (isWhatsAppGroupJidForTest(normalizedTarget)) {
    return { ok: true as const, to: normalizedTarget };
  }
  if (hasWildcard || allowList.length === 0 || allowList.includes(normalizedTarget)) {
    return { ok: true as const, to: normalizedTarget };
  }
  return {
    ok: false as const,
    error: new Error(
      `Target "${normalizedTarget}" is not listed in the configured WhatsApp allowFrom policy.`,
    ),
  };
}

const createCaseDir = async (prefix: string) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

const requireRecord = createRequireRecord("record", "expected-label-record");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectWhatsAppSendCall(
  sendWhatsApp: ReturnType<typeof vi.fn>,
  index: number,
  fields: { to: string; text: string },
) {
  const call = sendWhatsApp.mock.calls[index];
  if (!call) {
    throw new Error(`expected WhatsApp send call ${index}`);
  }
  expect(call[0]).toBe(fields.to);
  expect(call[1]).toBe(fields.text);
  requireRecord(call[2], `WhatsApp send call ${index} options`);
}

function expectReplyCall(
  replySpy: ReturnType<typeof vi.fn>,
  index: number,
  bodyFields: Record<string, unknown>,
  optionsFields?: Record<string, unknown>,
  cfg?: OpenClawConfig,
) {
  const call = replySpy.mock.calls[index];
  if (!call) {
    throw new Error(`expected reply call ${index}`);
  }
  const body = requireRecord(call[0], `reply call ${index} body`);
  for (const [key, value] of Object.entries(bodyFields)) {
    if (value instanceof RegExp) {
      expect(String(body[key])).toMatch(value);
    } else {
      expect(body[key]).toEqual(value);
    }
  }
  if (optionsFields) {
    expectRecordFields(requireRecord(call[1], `reply call ${index} options`), optionsFields);
  }
  if (cfg) {
    expect(call[2]).toBe(cfg);
  }
}

function replyBody(
  replySpy: ReturnType<typeof vi.fn>,
  index = 0,
): Pick<MsgContext, "Body" | "InternalTurnSource"> {
  const call = replySpy.mock.calls[index];
  return requireRecord(call?.[0], `reply call ${index} body`) as Pick<
    MsgContext,
    "Body" | "InternalTurnSource"
  >;
}

type HeartbeatSeedOverride = Partial<Parameters<typeof seedSessionStore>[2]>;

async function seedWhatsAppSession(
  storePath: string,
  sessionKey: string,
  entry: HeartbeatSeedOverride = {},
): Promise<void> {
  await seedSessionStore(storePath, sessionKey, {
    sessionId: "sid",
    updatedAt: Date.now(),
    lastChannel: "whatsapp",
    lastProvider: "whatsapp",
    lastTo: "120363401234567890@g.us",
    ...entry,
  });
}

beforeAll(async () => {
  previousRegistry = getActivePluginRegistry();

  const whatsappPlugin = createOutboundTestPlugin({
    id: "whatsapp",
    outbound: {
      ...whatsappOutboundForTest,
      resolveTarget: ({ to, allowFrom }) =>
        resolveWhatsAppTargetForTest({
          to,
          allowFrom,
        }),
    },
    messaging: {
      inferTargetChatType: ({ to }) => {
        const target = normalizeWhatsAppTargetForTest(to);
        return target ? (isWhatsAppGroupJidForTest(target) ? "group" : "direct") : undefined;
      },
    },
  });
  whatsappPlugin.config = {
    ...whatsappPlugin.config,
    resolveAllowFrom: ({ cfg }) => cfg.channels?.whatsapp?.allowFrom?.map((entry) => entry) ?? [],
  };

  const telegramPlugin = createOutboundTestPlugin({
    id: "telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ to, text, deps, accountId }) => {
        if (!deps?.["telegram"]) {
          throw new Error("sendTelegram missing");
        }
        const res = await (deps["telegram"] as Function)(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
      sendMedia: async ({ to, text, mediaUrl, deps, accountId }) => {
        if (!deps?.["telegram"]) {
          throw new Error("sendTelegram missing");
        }
        const res = await (deps["telegram"] as Function)(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
          mediaUrl,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
    },
    messaging: telegramMessagingForTest,
  });
  telegramPlugin.config = {
    ...telegramPlugin.config,
    listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? {}),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const channel = cfg.channels?.telegram;
      const normalized = accountId?.trim();
      if (normalized && channel?.accounts?.[normalized]?.allowFrom) {
        return channel.accounts[normalized].allowFrom?.map((entry) => String(entry)) ?? [];
      }
      return channel?.allowFrom?.map((entry) => String(entry)) ?? [];
    },
  };

  const discordPlugin = createOutboundTestPlugin({
    id: "discord",
    outbound: createDirectOutboundTestAdapter({ channel: "discord" }),
  });

  testRegistry = createTestRegistry([
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "discord", plugin: discordPlugin, source: "test" },
  ]);
  setActivePluginRegistry(testRegistry);

  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-suite-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(fixtureRoot, "state");
});

beforeEach(() => {
  resetSystemEventsForTest();
  resetHeartbeatEventsForTest();
  if (testRegistry) {
    setActivePluginRegistry(testRegistry);
  }
});

afterAll(async () => {
  if (fixtureRoot) {
    await closeOpenClawAgentDatabasesAsync(fixtureRoot);
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: path.join(fixtureRoot, "state") }),
    );
  }
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

describe("resolveHeartbeatDeliveryTarget", () => {
  const baseEntry = {
    sessionId: "sid",
    updatedAt: Date.now(),
  };
  const entryWithDelivery = (channel: string, to: string) => ({
    ...baseEntry,
    delivery: normalizeSessionDeliveryState({ context: { channel, to } }),
  });

  it("resolves target variants across route and allowlist rules", async () => {
    const targetConfig = (target: string, to?: string, allowFrom?: string[]): OpenClawConfig => ({
      agents: { defaults: { heartbeat: { target, to } } },
      ...(allowFrom ? { channels: { whatsapp: { allowFrom } } } : {}),
    });
    const check = async (
      cfg: OpenClawConfig,
      entry: typeof baseEntry & { delivery?: ReturnType<typeof normalizeSessionDeliveryState> },
      expected: Record<string, unknown>,
    ) =>
      expect(await resolveHeartbeatDeliveryTarget({ cfg, entry })).toMatchObject({
        accountId: undefined,
        lastAccountId: undefined,
        lastChannel:
          entry.delivery?.kind === "external" ? entry.delivery.context.channel : undefined,
        ...expected,
      });
    await check(targetConfig("none"), baseEntry, { channel: "none", reason: "target-none" });
    await check(
      {
        commands: { ownerAllowFrom: ["+15555550166"] },
        channels: { whatsapp: { allowFrom: ["+15555550166"] } },
      },
      entryWithDelivery("whatsapp", "120363401234567890@g.us"),
      { channel: "whatsapp", to: "+15555550166" },
    );
    await check({}, baseEntry, { channel: "none", reason: "no-route" });
    await check(targetConfig("whatsapp", "whatsapp:120363401234567890@G.US", ["*"]), baseEntry, {
      channel: "whatsapp",
      to: "120363401234567890@g.us",
    });
    await check({}, entryWithDelivery("webchat", "web"), {
      channel: "none",
      reason: "no-route",
      lastChannel: undefined,
    });
    await check(
      targetConfig("whatsapp", "+1999", ["120363401234567890@g.us", "+1666"]),
      entryWithDelivery("whatsapp", "+1222"),
      { channel: "none", reason: "no-target" },
    );
    await check(
      targetConfig("last", undefined, ["120363401234567890@g.us"]),
      entryWithDelivery("whatsapp", "whatsapp:120363401234567890@G.US"),
      { channel: "whatsapp", to: "120363401234567890@g.us" },
    );
    await check(targetConfig("telegram", "-100123"), baseEntry, {
      channel: "telegram",
      to: "-100123",
      chatType: "group",
    });
    await check(targetConfig("discord", "channel:123"), baseEntry, {
      channel: "discord",
      to: "channel:123",
      chatType: "channel",
    });
    await check(targetConfig("last"), entryWithDelivery("telegram", "5232990709"), {
      channel: "telegram",
      to: "5232990709",
      chatType: "direct",
    });
    await check(
      { agents: { defaults: { heartbeat: { target: "last", directPolicy: "block" } } } },
      entryWithDelivery("telegram", "5232990709"),
      { channel: "none", reason: "dm-blocked" },
    );
  });

  it.each([
    { name: "topic suffix", to: "-100111:topic:42", expectedTo: "-100111", expectedThreadId: 42 },
    { name: "plain chat id", to: "-100111", expectedTo: "-100111", expectedThreadId: undefined },
  ])(
    "parses optional telegram :topic: threadId suffix through session route: $name",
    async ({ to, expectedTo, expectedThreadId }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { target: "telegram", to },
          },
        },
      };
      const result = await resolveHeartbeatDeliveryTargetWithSessionRoute({
        cfg,
        agentId: "heartbeat-agent",
        entry: baseEntry,
      });
      expect(result.channel).toBe("telegram");
      expect(result.to).toBe(expectedTo);
      expect(result.threadId).toBe(expectedThreadId);
    },
  );
});

describe("resolveHeartbeatSenderContext", () => {
  it("prefers delivery accountId for allowFrom resolution", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["111"],
          accounts: {
            work: { allowFrom: ["222"], botToken: "token" },
          },
        },
      },
    };
    const entry = {
      sessionId: "sid",
      updatedAt: Date.now(),
      lastChannel: "telegram" as const,
      lastTo: "111",
      lastAccountId: "default",
    };
    const delivery = {
      channel: "telegram" as const,
      to: "999",
      accountId: "work",
      lastChannel: "telegram" as const,
      lastAccountId: "default",
    };

    const ctx = resolveHeartbeatSenderContext({ cfg, entry, delivery });

    expect(ctx.allowFrom).toEqual(["222"]);
  });
});

describe("runHeartbeatOnce", () => {
  function createWhatsAppSendMock() {
    return vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
  }

  const createHeartbeatDeps = (
    sendWhatsApp: (
      to: string,
      text: string,
      opts?: unknown,
    ) => Promise<{ messageId: string; toJid: string }>,
    options?: {
      nowMs?: number;
      getReplyFromConfig?: HeartbeatDeps["getReplyFromConfig"];
    },
  ): HeartbeatDeps => ({
    whatsapp: sendWhatsApp,
    getQueueSize: () => 0,
    nowMs: () => options?.nowMs ?? 0,
    webAuthExists: async () => true,
    hasActiveWebListener: () => true,
    ...(options?.getReplyFromConfig ? { getReplyFromConfig: options.getReplyFromConfig } : null),
  });

  it("skips when agent heartbeat is not enabled", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        entries: { main: {}, ops: { heartbeat: { every: "1h" } } },
      },
    };

    const res = await runHeartbeatOnce({ cfg, agentId: "main" });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("disabled");
    }
  });

  it("runs an exec-event wake for a configured agent when cadence is disabled", async () => {
    const tmpDir = await createCaseDir("hb-disabled-exec-event");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "0m", target: "none" },
        },
        entries: { main: {} },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await seedWhatsAppSession(storePath, sessionKey);
    enqueueSystemEvent("exec finished: backup completed", {
      sessionKey,
      contextKey: "exec:backup",
    });

    const replySpy = vi.fn();
    replySpy.mockResolvedValue({ text: "Handled internally" });
    const sendWhatsApp = createWhatsAppSendMock();

    const res = await runHeartbeatOnce({
      cfg,
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey,
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });

    expect(res.status).toBe("ran");
    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(replyBody(replySpy).InternalTurnSource).toBe("exec");
    expect(replyBody(replySpy).Body).toContain("Handle the result internally");
    expect(replyBody(replySpy).Body).not.toContain("Please relay the command output to the user");
  });

  it("skips a routeless interval poll before the agent run", async () => {
    const tmpDir = await createCaseDir("hb-no-route");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid-no-route",
      updatedAt: Date.now(),
    });
    const replySpy = vi.fn().mockResolvedValue({ text: "should not run" });

    const result = await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(vi.fn(), { getReplyFromConfig: replySpy }),
    });

    expect(result).toEqual({ status: "skipped", reason: "no-route" });
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("runs the agent when an explicit heartbeat target is rejected", async () => {
    const tmpDir = await createCaseDir("hb-rejected-explicit-target");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "whatsapp",
            to: "+15555550199",
          },
        },
      },
      channels: { whatsapp: { allowFrom: ["+15555550166"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid-rejected-explicit-target",
      updatedAt: Date.now(),
    });
    enqueueSystemEvent("Cron: inspect explicit delivery", {
      sessionKey,
      contextKey: "cron:rejected-explicit-target",
    });
    const replySpy = vi.fn().mockResolvedValue({ text: "agent ran" });
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

    const result = await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });

    expect(result.status).toBe("ran");
    expect(replySpy).toHaveBeenCalledOnce();
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });

  it("keeps active-hours protection for cron-carried heartbeat tasks", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          userTimezone: "UTC",
          heartbeat: {
            every: "30m",
            activeHours: { start: "08:00", end: "24:00", timezone: "user" },
          },
        },
      },
    };

    await expect(
      runHeartbeatOnce({
        cfg,
        source: "interval",
        intent: "task",
        reason: "heartbeat-task:job-inbox",
        tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
        deps: { nowMs: () => Date.UTC(2025, 0, 1, 7, 0, 0) },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "quiet-hours" });
    expect(getLastHeartbeatEvent()).toMatchObject({ status: "skipped", reason: "quiet-hours" });
  });

  it("persists implicit first-alert state when an isolated heartbeat starts without a base row", async () => {
    const tmpDir = await createCaseDir("hb-owner-preamble");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: tmpDir, heartbeat: { every: "5m", isolatedSession: true } },
      },
      commands: { ownerAllowFrom: ["+15555550166"] },
      channels: { whatsapp: { allowFrom: ["+15555550166"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    const isolatedSessionKey = `${sessionKey}:heartbeat`;
    const replySpy = vi
      .fn()
      .mockResolvedValueOnce({ text: "First alert" })
      .mockResolvedValueOnce({ text: "Second alert" })
      .mockResolvedValueOnce({ text: "Second alert" });
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

    await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(sendWhatsApp, { nowMs: 1, getReplyFromConfig: replySpy }),
    });
    let store = readSessionStoreForTest(storePath);
    expect(store[sessionKey]).toMatchObject({
      lastHeartbeatText: "First alert",
      lastHeartbeatSentAt: 1,
    });
    expectReplyCall(replySpy, 0, {
      SessionKey: isolatedSessionKey,
    });
    expect(store[isolatedSessionKey]?.lastHeartbeatText).toBeUndefined();

    await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(sendWhatsApp, { nowMs: 2, getReplyFromConfig: replySpy }),
    });
    await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(sendWhatsApp, { nowMs: 3, getReplyFromConfig: replySpy }),
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(sendWhatsApp.mock.calls[0]?.[0]).toBe("+15555550166");
    expect(sendWhatsApp.mock.calls[0]?.[1]).toContain("\nFirst alert");
    expectWhatsAppSendCall(sendWhatsApp, 1, {
      to: "+15555550166",
      text: "Second alert",
    });
    store = readSessionStoreForTest(storePath);
    expect(store[sessionKey]).toMatchObject({
      lastHeartbeatText: "Second alert",
      lastHeartbeatSentAt: 2,
    });
    expect(store[isolatedSessionKey]?.lastHeartbeatText).toBeUndefined();
  });

  it.each(["config", "forced"] as const)("routes to the %s session override", async (via) => {
    const caseDir = "hb-session-override";
    const peerId = "120363401234567891@g.us";
    const peerKind = "group";
    const message = "Group alert";
    const replySpy = vi.fn();
    const tmpDir = await createCaseDir(caseDir);
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = heartbeatTestConfig(tmpDir, "last", "whatsapp", storePath);
    const mainSessionKey = resolveMainSessionKey(cfg);
    const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
    const overrideSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "whatsapp",
      peerKind,
      peerId,
    });
    if (via === "config") {
      cfg.agents!.defaults!.heartbeat!.session = overrideSessionKey;
    }

    await seedWhatsAppSession(storePath, mainSessionKey, { sessionId: "sid-main" });
    await seedWhatsAppSession(storePath, overrideSessionKey, {
      sessionId: `sid-${peerKind}`,
      updatedAt: Date.now() + 10_000,
      lastTo: peerId,
    });

    replySpy.mockClear();
    replySpy.mockResolvedValue([{ text: message }]);
    const sendWhatsApp = createWhatsAppSendMock();

    await runHeartbeatOnce({
      cfg,
      sessionKey: via === "forced" ? overrideSessionKey : undefined,
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expectWhatsAppSendCall(sendWhatsApp, 0, { to: peerId, text: message });
    expectReplyCall(
      replySpy,
      0,
      {
        SessionKey: overrideSessionKey,
        From: peerId,
        To: peerId,
        InternalTurnSource: "heartbeat",
        Provider: undefined,
      },
      { isHeartbeat: true },
      cfg,
    );
  });

  it.each([
    {
      name: "subagent key via forcedSessionKey (opts.sessionKey)",
      injectVia: "opts" as const,
    },
    {
      name: "subagent key via heartbeat.session config",
      injectVia: "config" as const,
    },
  ])("falls back to main session when subagent key enters via $name", async ({ injectVia }) => {
    const replySpy = vi.fn();
    const tmpDir = await createCaseDir("hb-subagent-guard");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = heartbeatTestConfig(tmpDir, "last", "whatsapp", storePath);
    const mainSessionKey = resolveMainSessionKey(cfg);
    const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
    const subagentKey = `agent:${agentId}:subagent:task-abc`;

    if (injectVia === "config" && cfg.agents?.defaults?.heartbeat) {
      cfg.agents.defaults.heartbeat.session = subagentKey;
    }

    await seedWhatsAppSession(storePath, mainSessionKey, { sessionId: "sid-main" });
    await seedWhatsAppSession(storePath, subagentKey, {
      sessionId: "sid-subagent",
      updatedAt: Date.now() + 10_000,
      lastTo: "99999@g.us",
    });

    replySpy.mockClear();
    replySpy.mockResolvedValue([{ text: "Main session heartbeat" }]);
    const sendWhatsApp = createWhatsAppSendMock();

    await runHeartbeatOnce({
      cfg,
      ...(injectVia === "opts" ? { sessionKey: subagentKey } : {}),
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });

    expectReplyCall(replySpy, 0, { SessionKey: mainSessionKey });
    if (injectVia === "opts") {
      expectReplyCall(replySpy, 0, { OriginatingChannel: undefined, OriginatingTo: undefined });
    }
    expect(
      replySpy.mock.calls.some(
        ([body]) => requireRecord(body, "reply body").SessionKey === subagentKey,
      ),
    ).toBe(false);
  });

  it("delivers a repeated heartbeat when the clock moves behind its previous send", async () => {
    const tmpDir = await createCaseDir("hb-dup-clock-rollback");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.fn();
    const cfg: OpenClawConfig = heartbeatTestConfig(tmpDir, "whatsapp", "whatsapp", storePath);
    const sessionKey = resolveMainSessionKey(cfg);
    const nowMs = 60_000;
    await seedWhatsAppSession(storePath, sessionKey, {
      lastHeartbeatText: "Final alert",
      lastHeartbeatSentAt: nowMs + 60_000,
    });
    replySpy.mockResolvedValue([{ text: "Final alert" }]);
    const sendWhatsApp = createWhatsAppSendMock();

    await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(sendWhatsApp, { nowMs, getReplyFromConfig: replySpy }),
    });

    expect(sendWhatsApp).toHaveBeenCalledOnce();
    expectWhatsAppSendCall(sendWhatsApp, 0, {
      to: "120363401234567890@g.us",
      text: "Final alert",
    });
  });

  it("keeps a trailing legacy reasoning payload internal", async () => {
    // A legacy "Reasoning:"-prefixed payload after the final answer must not
    // become the visible heartbeat reply, and no separate Thinking message is
    // sent. (#92242 review follow-up)
    const replySpy = vi.fn();
    const tmpDir = await createCaseDir("hb-legacy-reasoning-unset");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = heartbeatTestConfig(tmpDir, "whatsapp", "whatsapp", storePath);
    const sessionKey = resolveMainSessionKey(cfg);
    await seedWhatsAppSession(storePath, sessionKey);

    replySpy.mockResolvedValue([
      { text: "All clear" },
      { text: "Reasoning: because nothing changed" },
    ]);
    const sendWhatsApp = createWhatsAppSendMock();

    await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expectWhatsAppSendCall(sendWhatsApp, 0, {
      to: "120363401234567890@g.us",
      text: "All clear",
    });
  });

  it("injects actionable scratch from the configured cron store without workspace file guidance", async () => {
    const tmpDir = await createCaseDir("hb-custom-scratch");
    const storePath = path.join(tmpDir, "sessions.json");
    const customCronStore = path.join(tmpDir, "custom-cron", "jobs.json");
    await seedHeartbeatScratchForTest({
      content: "- Check the custom cron partition\n",
      storePath: customCronStore,
    });
    const cfg = heartbeatTestConfig(tmpDir, "whatsapp", "whatsapp", storePath);
    writeConfigMachineState("cron.store", customCronStore);
    try {
      await seedWhatsAppSession(storePath, resolveMainSessionKey(cfg));
      const replySpy = vi.fn().mockResolvedValue({ text: "Checked custom partition" });
      const sendWhatsApp = createWhatsAppSendMock();
      const result = await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });
      expect(result.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledOnce();
      expect(replySpy).toHaveBeenCalledOnce();
      expect(replyBody(replySpy).Body).toContain("Heartbeat monitor scratch:");
      expect(replyBody(replySpy).Body).toContain("Check the custom cron partition");
      expect(replyBody(replySpy).Body).not.toContain("HEARTBEAT.md");
    } finally {
      deleteConfigMachineState("cron.store");
    }
  });
});
