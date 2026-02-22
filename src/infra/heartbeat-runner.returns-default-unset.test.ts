import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import * as replyModule from "../auto-reply/reply.js";
import { whatsappOutbound } from "../channels/plugins/outbound/whatsapp.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { typedCases } from "../test-utils/typed-cases.js";
import {
  type HeartbeatDeps,
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatPrompt,
  runHeartbeatOnce,
} from "./heartbeat-runner.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let testRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

let fixtureRoot = "";
let fixtureCount = 0;

const createCaseDir = async (prefix: string, { skipHeartbeatFile = false } = {}) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  if (!skipHeartbeatFile) {
    await fs.writeFile(path.join(dir, "HEARTBEAT.md"), "- Check status\n", "utf-8");
  }
  return dir;
};

beforeAll(async () => {
  previousRegistry = getActivePluginRegistry();

  const whatsappPlugin = createOutboundTestPlugin({ id: "whatsapp", outbound: whatsappOutbound });
  whatsappPlugin.config = {
    ...whatsappPlugin.config,
    resolveAllowFrom: ({ cfg }) =>
      cfg.channels?.whatsapp?.allowFrom?.map((entry) => String(entry)) ?? [],
  };

  const telegramPlugin = createOutboundTestPlugin({
    id: "telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ to, text, deps, accountId }) => {
        if (!deps?.sendTelegram) {
          throw new Error("sendTelegram missing");
        }
        const res = await deps.sendTelegram(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
      sendMedia: async ({ to, text, mediaUrl, deps, accountId }) => {
        if (!deps?.sendTelegram) {
          throw new Error("sendTelegram missing");
        }
        const res = await deps.sendTelegram(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
          mediaUrl,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
    },
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

  testRegistry = createTestRegistry([
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ]);
  setActivePluginRegistry(testRegistry);

  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-suite-"));
});

beforeEach(() => {
  resetSystemEventsForTest();
  if (testRegistry) {
    setActivePluginRegistry(testRegistry);
  }
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

describe("resolveHeartbeatIntervalMs", () => {
  it("returns default when unset", () => {
    expect(resolveHeartbeatIntervalMs({})).toBe(30 * 60_000);
  });

  it("returns null when invalid or zero", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "0m" } } },
      }),
    ).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "oops" } } },
      }),
    ).toBeNull();
  });

  it("parses duration strings with minute defaults", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5m" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "2h" } } },
      }),
    ).toBe(2 * 60 * 60_000);
  });

  it("uses explicit heartbeat overrides when provided", () => {
    expect(
      resolveHeartbeatIntervalMs(
        { agents: { defaults: { heartbeat: { every: "30m" } } } },
        undefined,
        { every: "5m" },
      ),
    ).toBe(5 * 60_000);
  });
});

describe("resolveHeartbeatPrompt", () => {
  it("uses default or trimmed override prompts", () => {
    const cases = [
      { cfg: {} as OpenClawConfig, expected: HEARTBEAT_PROMPT },
      {
        cfg: {
          agents: { defaults: { heartbeat: { prompt: "  ping  " } } },
        } as OpenClawConfig,
        expected: "ping",
      },
    ] as const;
    for (const testCase of cases) {
      expect(resolveHeartbeatPrompt(testCase.cfg)).toBe(testCase.expected);
    }
  });
});

describe("isHeartbeatEnabledForAgent", () => {
  it("enables only explicit heartbeat agents when configured", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("falls back to default agent when no explicit heartbeat entries", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(false);
  });
});

describe("resolveHeartbeatDeliveryTarget", () => {
  const baseEntry = {
    sessionId: "sid",
    updatedAt: Date.now(),
  };

  it("resolves target variants across route and allowlist rules", () => {
    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      entry: typeof baseEntry & {
        lastChannel?: "whatsapp" | "telegram" | "webchat";
        lastTo?: string;
      };
      expected: ReturnType<typeof resolveHeartbeatDeliveryTarget>;
    }> = [
      {
        name: "target none",
        cfg: { agents: { defaults: { heartbeat: { target: "none" } } } },
        entry: baseEntry,
        expected: {
          channel: "none",
          reason: "target-none",
          accountId: undefined,
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
      {
        name: "use last route by default",
        cfg: {},
        entry: { ...baseEntry, lastChannel: "whatsapp", lastTo: "+1555" },
        expected: {
          channel: "whatsapp",
          to: "+1555",
          accountId: undefined,
          lastChannel: "whatsapp",
          lastAccountId: undefined,
        },
      },
      {
        name: "normalize explicit whatsapp target when allowFrom wildcard",
        cfg: {
          agents: { defaults: { heartbeat: { target: "whatsapp", to: "whatsapp:(555) 123" } } },
          channels: { whatsapp: { allowFrom: ["*"] } },
        },
        entry: baseEntry,
        expected: {
          channel: "whatsapp",
          to: "+555123",
          accountId: undefined,
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
      {
        name: "skip webchat last route",
        cfg: {},
        entry: { ...baseEntry, lastChannel: "webchat", lastTo: "web" },
        expected: {
          channel: "none",
          reason: "no-target",
          accountId: undefined,
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
      {
        name: "reject explicit whatsapp target outside allowFrom",
        cfg: {
          agents: { defaults: { heartbeat: { target: "whatsapp", to: "+1999" } } },
          channels: { whatsapp: { allowFrom: ["+1555", "+1666"] } },
        },
        entry: { ...baseEntry, lastChannel: "whatsapp", lastTo: "+1222" },
        expected: {
          channel: "none",
          reason: "no-target",
          accountId: undefined,
          lastChannel: "whatsapp",
          lastAccountId: undefined,
        },
      },
      {
        name: "normalize prefixed whatsapp group targets",
        cfg: { channels: { whatsapp: { allowFrom: ["+1555"] } } },
        entry: {
          ...baseEntry,
          lastChannel: "whatsapp",
          lastTo: "whatsapp:120363401234567890@G.US",
        },
        expected: {
          channel: "whatsapp",
          to: "120363401234567890@g.us",
          accountId: undefined,
          lastChannel: "whatsapp",
          lastAccountId: undefined,
        },
      },
      {
        name: "keep explicit telegram target",
        cfg: { agents: { defaults: { heartbeat: { target: "telegram", to: "123" } } } },
        entry: baseEntry,
        expected: {
          channel: "telegram",
          to: "123",
          accountId: undefined,
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
    ];
    for (const testCase of cases) {
      expect(
        resolveHeartbeatDeliveryTarget({ cfg: testCase.cfg, entry: testCase.entry }),
        testCase.name,
      ).toEqual(testCase.expected);
    }
  });

  it("parses optional telegram :topic: threadId suffix", () => {
    const cases = [
      { to: "-100111:topic:42", expectedTo: "-100111", expectedThreadId: 42 },
      { to: "-100111", expectedTo: "-100111", expectedThreadId: undefined },
    ] as const;
    for (const testCase of cases) {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { target: "telegram", to: testCase.to },
          },
        },
      };
      const result = resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry });
      expect(result.channel).toBe("telegram");
      expect(result.to).toBe(testCase.expectedTo);
      expect(result.threadId).toBe(testCase.expectedThreadId);
    }
  });

  it("handles explicit heartbeat accountId allow/deny", () => {
    const cases = [
      {
        accountId: "work",
        expected: {
          channel: "telegram",
          to: "123",
          accountId: "work",
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
      {
        accountId: "missing",
        expected: {
          channel: "none",
          reason: "unknown-account",
          accountId: "missing",
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { target: "telegram", to: "123", accountId: testCase.accountId },
          },
        },
        channels: { telegram: { accounts: { work: { botToken: "token" } } } },
      };
      expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual(testCase.expected);
    }
  });

  it("prefers per-agent heartbeat overrides when provided", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { heartbeat: { target: "telegram", to: "123" } } },
    };
    const heartbeat = { target: "whatsapp", to: "+1555" } as const;
    expect(
      resolveHeartbeatDeliveryTarget({
        cfg,
        entry: { ...baseEntry, lastChannel: "whatsapp", lastTo: "+1999" },
        heartbeat,
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });
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
  const createHeartbeatDeps = (
    sendWhatsApp: NonNullable<HeartbeatDeps["sendWhatsApp"]>,
    nowMs = 0,
  ): HeartbeatDeps => ({
    sendWhatsApp,
    getQueueSize: () => 0,
    nowMs: () => nowMs,
    webAuthExists: async () => true,
    hasActiveWebListener: () => true,
  });

  it("skips when agent heartbeat is not enabled", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };

    const res = await runHeartbeatOnce({ cfg, agentId: "main" });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("disabled");
    }
  });

  it("skips outside active hours", async () => {
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

    const res = await runHeartbeatOnce({
      cfg,
      deps: { nowMs: () => Date.UTC(2025, 0, 1, 7, 0, 0) },
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("quiet-hours");
    }
  });

  it("uses the last non-empty payload for delivery", async () => {
    const tmpDir = await createCaseDir("hb-last-payload");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Let me check..." }, { text: "Final alert" }]);
      const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith("+1555", "Final alert", expect.any(Object));
    } finally {
      replySpy.mockRestore();
    }
  });

  it("uses per-agent heartbeat overrides and session keys", async () => {
    const tmpDir = await createCaseDir("hb-agent-overrides");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m", prompt: "Default prompt" },
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp", prompt: "Ops check" },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        }),
      );
      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });
      await runHeartbeatOnce({
        cfg,
        agentId: "ops",
        deps: createHeartbeatDeps(sendWhatsApp),
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith("+1555", "Final alert", expect.any(Object));
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: expect.stringMatching(/Ops check[\s\S]*Current time: /),
          SessionKey: sessionKey,
          From: "+1555",
          To: "+1555",
          Provider: "heartbeat",
        }),
        expect.objectContaining({ isHeartbeat: true, suppressToolErrorWarnings: false }),
        cfg,
      );
    } finally {
      replySpy.mockRestore();
    }
  });

  it("reuses non-default agent sessionFile from templated stores", async () => {
    const tmpDir = await createCaseDir("hb-templated-store");
    const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const agentId = "ops";
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m", prompt: "Default prompt" },
          },
          list: [
            { id: "main", default: true },
            {
              id: agentId,
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp", prompt: "Ops check" },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storeTemplate },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
      const storePath = resolveStorePath(storeTemplate, { agentId });
      const sessionsDir = path.dirname(storePath);
      const sessionId = "sid-ops";
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(sessionFile, "", "utf-8");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId,
              sessionFile,
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });
      const result = await runHeartbeatOnce({
        cfg,
        agentId,
        deps: createHeartbeatDeps(sendWhatsApp),
      });

      expect(result.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith("+1555", "Final alert", expect.any(Object));
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: sessionKey,
          From: "+1555",
          To: "+1555",
          Provider: "heartbeat",
        }),
        expect.objectContaining({ isHeartbeat: true, suppressToolErrorWarnings: false }),
        cfg,
      );
    } finally {
      replySpy.mockRestore();
    }
  });

  it("resolves configured and forced session key overrides", async () => {
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cases = typedCases<{
        name: string;
        caseDir: string;
        peerKind: "group" | "direct";
        peerId: string;
        message: string;
        applyOverride: (params: { cfg: OpenClawConfig; sessionKey: string }) => void;
        runOptions: (params: { sessionKey: string }) => { sessionKey?: string };
      }>([
        {
          name: "heartbeat.session",
          caseDir: "hb-explicit-session",
          peerKind: "group" as const,
          peerId: "120363401234567890@g.us",
          message: "Group alert",
          applyOverride: ({ cfg, sessionKey }: { cfg: OpenClawConfig; sessionKey: string }) => {
            if (cfg.agents?.defaults?.heartbeat) {
              cfg.agents.defaults.heartbeat.session = sessionKey;
            }
          },
          runOptions: ({ sessionKey: _sessionKey }: { sessionKey: string }) => ({
            sessionKey: undefined as string | undefined,
          }),
        },
        {
          name: "runHeartbeatOnce sessionKey arg",
          caseDir: "hb-forced-session-override",
          peerKind: "direct" as const,
          peerId: "+15559990000",
          message: "Forced alert",
          applyOverride: () => {},
          runOptions: ({ sessionKey }: { sessionKey: string }) => ({ sessionKey }),
        },
      ]);

      for (const testCase of cases) {
        const tmpDir = await createCaseDir(testCase.caseDir);
        const storePath = path.join(tmpDir, "sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "last",
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const mainSessionKey = resolveMainSessionKey(cfg);
        const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
        const overrideSessionKey = buildAgentPeerSessionKey({
          agentId,
          channel: "whatsapp",
          peerKind: testCase.peerKind,
          peerId: testCase.peerId,
        });
        testCase.applyOverride({ cfg, sessionKey: overrideSessionKey });

        await fs.writeFile(
          storePath,
          JSON.stringify({
            [mainSessionKey]: {
              sessionId: "sid-main",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
            [overrideSessionKey]: {
              sessionId: `sid-${testCase.peerKind}`,
              updatedAt: Date.now() + 10_000,
              lastChannel: "whatsapp",
              lastTo: testCase.peerId,
            },
          }),
        );

        replySpy.mockReset();
        replySpy.mockResolvedValue([{ text: testCase.message }]);
        const sendWhatsApp = vi
          .fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>()
          .mockResolvedValue({ messageId: "m1", toJid: "jid" });

        await runHeartbeatOnce({
          cfg,
          ...testCase.runOptions({ sessionKey: overrideSessionKey }),
          deps: createHeartbeatDeps(sendWhatsApp),
        });

        expect(sendWhatsApp, testCase.name).toHaveBeenCalledTimes(1);
        expect(sendWhatsApp, testCase.name).toHaveBeenCalledWith(
          testCase.peerId,
          testCase.message,
          expect.any(Object),
        );
        expect(replySpy, testCase.name).toHaveBeenCalledWith(
          expect.objectContaining({
            SessionKey: overrideSessionKey,
            From: testCase.peerId,
            To: testCase.peerId,
            Provider: "heartbeat",
          }),
          expect.objectContaining({ isHeartbeat: true, suppressToolErrorWarnings: false }),
          cfg,
        );
      }
    } finally {
      replySpy.mockRestore();
    }
  });

  it("suppresses duplicate heartbeat payloads within 24h", async () => {
    const tmpDir = await createCaseDir("hb-dup-suppress");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
            lastHeartbeatText: "Final alert",
            lastHeartbeatSentAt: 0,
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>()
        .mockResolvedValue({ messageId: "m1", toJid: "jid" });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp, 60_000),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("handles reasoning payload delivery variants", async () => {
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cases = typedCases<{
        name: string;
        caseDir: string;
        replies: Array<{ text: string }>;
        expectedTexts: string[];
      }>([
        {
          name: "reasoning + final payload",
          caseDir: "hb-reasoning",
          replies: [{ text: "Reasoning:\n_Because it helps_" }, { text: "Final alert" }],
          expectedTexts: ["Reasoning:\n_Because it helps_", "Final alert"],
        },
        {
          name: "reasoning + HEARTBEAT_OK",
          caseDir: "hb-reasoning-heartbeat-ok",
          replies: [{ text: "Reasoning:\n_Because it helps_" }, { text: "HEARTBEAT_OK" }],
          expectedTexts: ["Reasoning:\n_Because it helps_"],
        },
      ]);

      for (const testCase of cases) {
        const tmpDir = await createCaseDir(testCase.caseDir);
        const storePath = path.join(tmpDir, "sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "whatsapp",
                includeReasoning: true,
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = resolveMainSessionKey(cfg);

        await fs.writeFile(
          storePath,
          JSON.stringify({
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          }),
        );

        replySpy.mockReset();
        replySpy.mockResolvedValue(testCase.replies);
        const sendWhatsApp = vi
          .fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>()
          .mockResolvedValue({ messageId: "m1", toJid: "jid" });

        await runHeartbeatOnce({
          cfg,
          deps: createHeartbeatDeps(sendWhatsApp),
        });

        expect(sendWhatsApp, testCase.name).toHaveBeenCalledTimes(testCase.expectedTexts.length);
        for (const [index, text] of testCase.expectedTexts.entries()) {
          expect(sendWhatsApp, testCase.name).toHaveBeenNthCalledWith(
            index + 1,
            "+1555",
            text,
            expect.any(Object),
          );
        }
      }
    } finally {
      replySpy.mockRestore();
    }
  });

  it("loads the default agent session from templated stores", async () => {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: tmpDir, heartbeat: { every: "5m" } },
          list: [{ id: "work", default: true }],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storeTemplate },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const storePath = resolveStorePath(storeTemplate, { agentId });

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
      const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(
        "+1555",
        "Hello from heartbeat",
        expect.any(Object),
      );
    } finally {
      replySpy.mockRestore();
    }
  });

  type HeartbeatFileState = "empty" | "actionable" | "missing" | "read-error";

  async function runHeartbeatFileScenario(params: {
    fileState: HeartbeatFileState;
    reason?: "interval" | "wake";
    queueCronEvent?: boolean;
    replyText?: string;
  }) {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    if (params.fileState === "empty") {
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n## Tasks\n\n",
        "utf-8",
      );
    } else if (params.fileState === "actionable") {
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n- Check server logs\n- Review pending PRs\n",
        "utf-8",
      );
    } else if (params.fileState === "read-error") {
      // readFile on a directory triggers EISDIR.
      await fs.mkdir(path.join(workspaceDir, "HEARTBEAT.md"), { recursive: true });
    }

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: { every: "5m", target: "whatsapp" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
    );
    if (params.queueCronEvent) {
      enqueueSystemEvent("Cron: QMD maintenance completed", {
        sessionKey,
        contextKey: "cron:qmd-maintenance",
      });
    }

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue({ text: params.replyText ?? "Checked logs and PRs" });
    const sendWhatsApp = vi
      .fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
    const res = await runHeartbeatOnce({
      cfg,
      reason: params.reason,
      deps: createHeartbeatDeps(sendWhatsApp),
    });
    return { res, replySpy, sendWhatsApp };
  }

  it("applies HEARTBEAT.md gating rules across file states and triggers", async () => {
    const cases: Array<{
      name: string;
      fileState: HeartbeatFileState;
      reason?: "interval" | "wake";
      queueCronEvent?: boolean;
      expectedStatus: "ran" | "skipped";
      expectedSkipReason?: "empty-heartbeat-file";
      expectedSendCalls: number;
      expectedReplyCalls: number;
      expectCronContext?: boolean;
      replyText?: string;
    }> = [
      {
        name: "empty file + interval skips",
        fileState: "empty",
        expectedStatus: "skipped",
        expectedSkipReason: "empty-heartbeat-file",
        expectedSendCalls: 0,
        expectedReplyCalls: 0,
      },
      {
        name: "empty file + wake runs",
        fileState: "empty",
        reason: "wake",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        replyText: "wake event processed",
      },
      {
        name: "empty file + queued cron interval runs",
        fileState: "empty",
        reason: "interval",
        queueCronEvent: true,
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        expectCronContext: true,
        replyText: "Relay this cron update now",
      },
      {
        name: "actionable file runs",
        fileState: "actionable",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "missing file runs",
        fileState: "missing",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "read error runs",
        fileState: "read-error",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "missing file + wake runs",
        fileState: "missing",
        reason: "wake",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        replyText: "wake event processed",
      },
      {
        name: "missing file + queued cron interval runs",
        fileState: "missing",
        reason: "interval",
        queueCronEvent: true,
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        expectCronContext: true,
        replyText: "Relay this cron update now",
      },
    ];

    for (const testCase of cases) {
      const { res, replySpy, sendWhatsApp } = await runHeartbeatFileScenario(testCase);
      try {
        expect(res.status, testCase.name).toBe(testCase.expectedStatus);
        if (res.status === "skipped") {
          expect(res.reason, testCase.name).toBe(testCase.expectedSkipReason);
        }
        expect(replySpy, testCase.name).toHaveBeenCalledTimes(testCase.expectedReplyCalls);
        expect(sendWhatsApp, testCase.name).toHaveBeenCalledTimes(testCase.expectedSendCalls);
        if (testCase.expectCronContext) {
          const calledCtx = replySpy.mock.calls[0]?.[0] as { Provider?: string; Body?: string };
          expect(calledCtx.Provider, testCase.name).toBe("cron-event");
          expect(calledCtx.Body, testCase.name).toContain("scheduled reminder has been triggered");
        }
      } finally {
        replySpy.mockRestore();
      }
    }
  });
});
