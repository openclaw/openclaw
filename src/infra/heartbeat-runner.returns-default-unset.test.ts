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
import {
  bindHeartbeatReply,
  bindHeartbeatSend,
  inactiveHeartbeatHours,
  observeHeartbeatClock,
} from "./heartbeat-runner.boundary-test-support.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
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

function expectWhatsAppSendCall(
  sendWhatsApp: ReturnType<typeof vi.fn>,
  index: number,
  fields: { to: string; text: string },
) {
  expect(sendWhatsApp.mock.calls[index]?.slice(0, 2)).toEqual([fields.to, fields.text]);
  requireRecord(sendWhatsApp.mock.calls[index]?.[2], `WhatsApp send call ${index} options`);
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
    expect(body[key]).toEqual(value);
  }
  if (optionsFields) {
    expect(requireRecord(call[1], `reply call ${index} options`)).toMatchObject(optionsFields);
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
  it("prefers delivery accountId for allowFrom resolution", async () => {
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

    const ctx = await resolveHeartbeatSenderContext({ cfg, entry, delivery });

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

  async function heartbeatCase(
    prefix: string,
    config: Parameters<typeof heartbeatTestConfig>[1] | OpenClawConfig = "whatsapp",
  ) {
    const tmpDir = await createCaseDir(prefix);
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig =
      typeof config === "string"
        ? heartbeatTestConfig(tmpDir, config, "whatsapp", storePath)
        : {
            ...config,
            agents: {
              ...config.agents,
              defaults: { ...config.agents?.defaults, workspace: tmpDir },
            },
            session: { store: storePath },
          };
    const replySpy = vi.fn();
    const sendWhatsApp = createWhatsAppSendMock();
    bindHeartbeatReply(replySpy);
    bindHeartbeatSend("whatsapp", sendWhatsApp);
    const clock = observeHeartbeatClock();
    return {
      tmpDir,
      storePath,
      cfg,
      replySpy,
      sendWhatsApp,
      sessionKey: resolveMainSessionKey(cfg),
      clock,
      run: (options: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg"> = {}) =>
        runHeartbeatOnce({
          cfg,
          ...options,
        }),
    };
  }

  it("skips when agent heartbeat is not enabled", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        entries: { main: {}, ops: { heartbeat: { every: "1h" } } },
      },
    };

    const res = await runHeartbeatOnce({ cfg, agentId: "main" });
    expect(res).toMatchObject({ status: "skipped", reason: "disabled" });
  });

  it("runs an exec-event wake for a configured agent when cadence is disabled", async () => {
    const h = await heartbeatCase("hb-disabled-exec-event", {
      agents: {
        defaults: { heartbeat: { every: "0m", target: "none" } },
        entries: { main: {} },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    await seedWhatsAppSession(h.storePath, h.sessionKey);
    enqueueSystemEvent("exec finished: backup completed", {
      sessionKey: h.sessionKey,
      contextKey: "exec:backup",
    });
    h.replySpy.mockResolvedValue({ text: "Handled internally" });
    const res = await h.run({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey: h.sessionKey,
    });

    expect(res.status).toBe("ran");
    expect(h.sendWhatsApp).not.toHaveBeenCalled();
    expect(replyBody(h.replySpy).InternalTurnSource).toBe("exec");
    expect(replyBody(h.replySpy).Body).toContain("Handle the result internally");
    expect(replyBody(h.replySpy).Body).not.toContain("Please relay the command output to the user");
  });

  it("skips a routeless interval poll before the agent run", async () => {
    const h = await heartbeatCase("hb-no-route", {
      agents: { defaults: { heartbeat: { every: "5m" } } },
    });
    await seedSessionStore(h.storePath, h.sessionKey, {
      sessionId: "sid-no-route",
      updatedAt: Date.now(),
    });
    h.replySpy.mockResolvedValue({ text: "should not run" });
    h.sendWhatsApp.mockReset();
    const result = await h.run();
    expect(result).toEqual({ status: "skipped", reason: "no-route" });
    expect(h.replySpy).not.toHaveBeenCalled();
  });

  it("runs the agent when an explicit heartbeat target is rejected", async () => {
    const h = await heartbeatCase("hb-rejected-explicit-target", {
      agents: {
        defaults: {
          heartbeat: {
            every: "5m",
            target: "whatsapp",
            to: "+15555550199",
          },
        },
      },
      channels: { whatsapp: { allowFrom: ["+15555550166"] } },
    });
    await seedSessionStore(h.storePath, h.sessionKey, {
      sessionId: "sid-rejected-explicit-target",
      updatedAt: Date.now(),
    });
    enqueueSystemEvent("Cron: inspect explicit delivery", {
      sessionKey: h.sessionKey,
      contextKey: "cron:rejected-explicit-target",
    });
    h.replySpy.mockResolvedValue({ text: "agent ran" });
    const result = await h.run();

    expect(result.status).toBe("ran");
    expect(h.replySpy).toHaveBeenCalledOnce();
    expect(h.sendWhatsApp).not.toHaveBeenCalled();
  });

  it("keeps active-hours protection for cron-carried heartbeat tasks", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          userTimezone: "UTC",
          heartbeat: {
            every: "30m",
            activeHours: inactiveHeartbeatHours(),
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
      }),
    ).resolves.toEqual({ status: "skipped", reason: "quiet-hours" });
    expect(getLastHeartbeatEvent()).toMatchObject({ status: "skipped", reason: "quiet-hours" });
  });

  it("persists implicit first-alert state when an isolated heartbeat starts without a base row", async () => {
    const h = await heartbeatCase("hb-owner-preamble", {
      agents: {
        defaults: { heartbeat: { every: "5m", isolatedSession: true } },
      },
      commands: { ownerAllowFrom: ["+15555550166"] },
      channels: { whatsapp: { allowFrom: ["+15555550166"] } },
    });
    const isolatedSessionKey = `${h.sessionKey}:heartbeat`;
    h.replySpy
      .mockResolvedValueOnce({ text: "First alert" })
      .mockResolvedValueOnce({ text: "Second alert" })
      .mockResolvedValueOnce({ text: "Second alert" });
    const first = await h.clock.run(() => h.run());
    let store = readSessionStoreForTest(h.storePath);
    expect(store[h.sessionKey]).toMatchObject({
      lastHeartbeatText: "First alert",
      lastHeartbeatSentAt: first.startedAt,
    });
    expectReplyCall(h.replySpy, 0, {
      SessionKey: isolatedSessionKey,
    });
    expect(store[isolatedSessionKey]?.lastHeartbeatText).toBeUndefined();

    const second = await h.clock.run(() => h.run());
    await h.run();
    expect(h.sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(h.sendWhatsApp.mock.calls[0]?.[0]).toBe("+15555550166");
    expect(h.sendWhatsApp.mock.calls[0]?.[1]).toContain("\nFirst alert");
    expectWhatsAppSendCall(h.sendWhatsApp, 1, {
      to: "+15555550166",
      text: "Second alert",
    });
    store = readSessionStoreForTest(h.storePath);
    expect(store[h.sessionKey]).toMatchObject({
      lastHeartbeatText: "Second alert",
      lastHeartbeatSentAt: second.startedAt,
    });
    expect(store[isolatedSessionKey]?.lastHeartbeatText).toBeUndefined();
  });

  it.each(["config", "forced"] as const)("routes to the %s session override", async (via) => {
    const peerId = "120363401234567891@g.us";
    const peerKind = "group";
    const message = "Group alert";
    const h = await heartbeatCase("hb-session-override", "last");
    const agentId = resolveAgentIdFromSessionKey(h.sessionKey);
    const overrideSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "whatsapp",
      peerKind,
      peerId,
    });
    if (via === "config") {
      h.cfg.agents!.defaults!.heartbeat!.session = overrideSessionKey;
    }

    await seedWhatsAppSession(h.storePath, h.sessionKey, { sessionId: "sid-main" });
    await seedWhatsAppSession(h.storePath, overrideSessionKey, {
      sessionId: `sid-${peerKind}`,
      updatedAt: Date.now() + 10_000,
      lastTo: peerId,
    });

    h.replySpy.mockResolvedValue([{ text: message }]);
    await h.run({
      sessionKey: via === "forced" ? overrideSessionKey : undefined,
    });

    expect(h.sendWhatsApp).toHaveBeenCalledTimes(1);
    expectWhatsAppSendCall(h.sendWhatsApp, 0, { to: peerId, text: message });
    expectReplyCall(
      h.replySpy,
      0,
      {
        SessionKey: overrideSessionKey,
        From: peerId,
        To: peerId,
        InternalTurnSource: "heartbeat",
        Provider: undefined,
      },
      { isHeartbeat: true },
      h.cfg,
    );
  });

  it.each(["opts", "config"] as const)(
    "falls back to main session for a subagent key via %s",
    async (injectVia) => {
      const h = await heartbeatCase("hb-subagent-guard", "last");
      const agentId = resolveAgentIdFromSessionKey(h.sessionKey);
      const subagentKey = `agent:${agentId}:subagent:task-abc`;

      if (injectVia === "config" && h.cfg.agents?.defaults?.heartbeat) {
        h.cfg.agents.defaults.heartbeat.session = subagentKey;
      }

      await seedWhatsAppSession(h.storePath, h.sessionKey, { sessionId: "sid-main" });
      await seedWhatsAppSession(h.storePath, subagentKey, {
        sessionId: "sid-subagent",
        updatedAt: Date.now() + 10_000,
        lastTo: "99999@g.us",
      });

      h.replySpy.mockResolvedValue([{ text: "Main session heartbeat" }]);
      await h.run(injectVia === "opts" ? { sessionKey: subagentKey } : {});

      expectReplyCall(h.replySpy, 0, { SessionKey: h.sessionKey });
      if (injectVia === "opts") {
        expectReplyCall(h.replySpy, 0, { OriginatingChannel: undefined, OriginatingTo: undefined });
      }
      expect(
        h.replySpy.mock.calls.some(
          ([body]) => requireRecord(body, "reply body").SessionKey === subagentKey,
        ),
      ).toBe(false);
    },
  );

  it("delivers a repeated heartbeat when the clock moves behind its previous send", async () => {
    const { storePath, sessionKey, replySpy, sendWhatsApp, run, clock } =
      await heartbeatCase("hb-dup-clock-rollback");
    const previousSendAt = Date.now() + 24 * 60 * 60_000;
    await seedWhatsAppSession(storePath, sessionKey, {
      lastHeartbeatText: "Final alert",
      lastHeartbeatSentAt: previousSendAt,
    });
    replySpy.mockResolvedValue([{ text: "Final alert" }]);
    const { startedAt } = await clock.run(() => run());
    expect(startedAt).toBeLessThan(previousSendAt);

    expect(sendWhatsApp).toHaveBeenCalledOnce();
    expectWhatsAppSendCall(sendWhatsApp, 0, {
      to: "120363401234567890@g.us",
      text: "Final alert",
    });
  });

  it("keeps a trailing legacy reasoning payload internal", async () => {
    // #92242: trailing legacy reasoning must not replace or accompany the visible reply.
    const { storePath, sessionKey, replySpy, sendWhatsApp, run } = await heartbeatCase(
      "hb-legacy-reasoning-unset",
    );
    await seedWhatsAppSession(storePath, sessionKey);

    replySpy.mockResolvedValue([
      { text: "All clear" },
      { text: "Reasoning: because nothing changed" },
    ]);
    await run();

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expectWhatsAppSendCall(sendWhatsApp, 0, {
      to: "120363401234567890@g.us",
      text: "All clear",
    });
  });

  it("injects actionable scratch from the configured cron store without workspace file guidance", async () => {
    const { tmpDir, storePath, sessionKey, replySpy, sendWhatsApp, run } =
      await heartbeatCase("hb-custom-scratch");
    const customCronStore = path.join(tmpDir, "custom-cron", "jobs.json");
    await seedHeartbeatScratchForTest({
      content: "- Check the custom cron partition\n",
      storePath: customCronStore,
    });
    writeConfigMachineState("cron.store", customCronStore);
    try {
      await seedWhatsAppSession(storePath, sessionKey);
      replySpy.mockResolvedValue({ text: "Checked custom partition" });
      const result = await run();
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
