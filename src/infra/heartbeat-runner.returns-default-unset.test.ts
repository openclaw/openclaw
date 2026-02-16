import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import * as replyModule from "../auto-reply/reply.js";
import { whatsappOutbound } from "../channels/plugins/outbound/whatsapp.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatPrompt,
  runHeartbeatOnce,
} from "./heartbeat-runner.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let testRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

let fixtureRoot = "";
let fixtureCount = 0;

const createCaseDir = async (prefix: string) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
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
  it("uses the default prompt when unset", () => {
    expect(resolveHeartbeatPrompt({})).toBe(HEARTBEAT_PROMPT);
  });

  it("uses a trimmed override when configured", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { heartbeat: { prompt: "  ping  " } } },
    };
    expect(resolveHeartbeatPrompt(cfg)).toBe("ping");
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

  it("respects target none", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { heartbeat: { target: "none" } } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "none",
      reason: "target-none",
      accountId: undefined,
      lastChannel: undefined,
      lastAccountId: undefined,
    });
  });

  it("uses last route by default", () => {
    const cfg: OpenClawConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "+1555",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });

  it("normalizes explicit WhatsApp targets when allowFrom is '*'", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { target: "whatsapp", to: "whatsapp:(555) 123" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "whatsapp",
      to: "+555123",
      accountId: undefined,
      lastChannel: undefined,
      lastAccountId: undefined,
    });
  });

  it("skips when last route is webchat", () => {
    const cfg: OpenClawConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "webchat" as const,
      lastTo: "web",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "none",
      reason: "no-target",
      accountId: undefined,
      lastChannel: undefined,
      lastAccountId: undefined,
    });
  });

  it("rejects WhatsApp target not in allowFrom (no silent fallback)", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { heartbeat: { target: "whatsapp", to: "+1999" } } },
      channels: { whatsapp: { allowFrom: ["+1555", "+1666"] } },
    };
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "+1222",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "none",
      reason: "no-target",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });

  it("normalizes prefixed WhatsApp group targets for heartbeat delivery", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["+1555"] } },
    };
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "whatsapp:120363401234567890@G.US",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "120363401234567890@g.us",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });

  it("uses explicit heartbeat accountId when provided", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { target: "telegram", to: "123", accountId: "work" },
        },
      },
      channels: { telegram: { accounts: { work: { botToken: "token" } } } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "telegram",
      to: "123",
      accountId: "work",
      lastChannel: undefined,
      lastAccountId: undefined,
    });
  });

  it("skips when explicit heartbeat accountId is unknown", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { target: "telegram", to: "123", accountId: "missing" },
        },
      },
      channels: { telegram: { accounts: { work: { botToken: "token" } } } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "none",
      reason: "unknown-account",
      accountId: "missing",
      lastChannel: undefined,
      lastAccountId: undefined,
    });
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
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
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
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });
      await runHeartbeatOnce({
        cfg,
        agentId: "ops",
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith("+1555", "Final alert", expect.any(Object));
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: expect.stringMatching(/Ops check[\s\S]*Current time: /),
          SessionKey: sessionKey,
        }),
        { isHeartbeat: true },
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
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });
      const result = await runHeartbeatOnce({
        cfg,
        agentId,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(result.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith("+1555", "Final alert", expect.any(Object));
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({ SessionKey: sessionKey }),
        { isHeartbeat: true },
        cfg,
      );
    } finally {
      replySpy.mockRestore();
    }
  });

  it("runs heartbeats in the explicit session key when configured", async () => {
    const tmpDir = await createCaseDir("hb-explicit-session");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const groupId = "120363401234567890@g.us";
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
      const groupSessionKey = buildAgentPeerSessionKey({
        agentId,
        channel: "whatsapp",
        peerKind: "group",
        peerId: groupId,
      });
      if (cfg.agents?.defaults?.heartbeat) {
        cfg.agents.defaults.heartbeat.session = groupSessionKey;
      }

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [mainSessionKey]: {
            sessionId: "sid-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
          [groupSessionKey]: {
            sessionId: "sid-group",
            updatedAt: Date.now() + 10_000,
            lastChannel: "whatsapp",
            lastTo: groupId,
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Group alert" }]);
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(groupId, "Group alert", expect.any(Object));
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({ SessionKey: groupSessionKey }),
        { isHeartbeat: true },
        cfg,
      );
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
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 60_000,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("can include reasoning payloads when enabled", async () => {
    const tmpDir = await createCaseDir("hb-reasoning");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
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

      replySpy.mockResolvedValue([
        { text: "Reasoning:\n_Because it helps_" },
        { text: "Final alert" },
      ]);
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(2);
      expect(sendWhatsApp).toHaveBeenNthCalledWith(
        1,
        "+1555",
        "Reasoning:\n_Because it helps_",
        expect.any(Object),
      );
      expect(sendWhatsApp).toHaveBeenNthCalledWith(2, "+1555", "Final alert", expect.any(Object));
    } finally {
      replySpy.mockRestore();
    }
  });

  it("delivers reasoning even when the main heartbeat reply is HEARTBEAT_OK", async () => {
    const tmpDir = await createCaseDir("hb-reasoning-heartbeat-ok");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
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

      replySpy.mockResolvedValue([
        { text: "Reasoning:\n_Because it helps_" },
        { text: "HEARTBEAT_OK" },
      ]);
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenNthCalledWith(
        1,
        "+1555",
        "Reasoning:\n_Because it helps_",
        expect.any(Object),
      );
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
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
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

  it("skips heartbeat when HEARTBEAT.md is effectively empty (saves API calls)", async () => {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });

      // Create effectively empty HEARTBEAT.md (only header and comments)
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n## Tasks\n\n",
        "utf-8",
      );

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

      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      // Should skip without making API call
      expect(res.status).toBe("skipped");
      if (res.status === "skipped") {
        expect(res.reason).toBe("empty-heartbeat-file");
      }
      expect(replySpy).not.toHaveBeenCalled();
      expect(sendWhatsApp).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });

  it("does not skip wake-triggered heartbeat when HEARTBEAT.md is effectively empty", async () => {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n## Tasks\n\n",
        "utf-8",
      );

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

      replySpy.mockResolvedValue({ text: "wake event processed" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "wake",
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("runs heartbeat when HEARTBEAT.md has actionable content", async () => {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });

      // Create HEARTBEAT.md with actionable content
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n- Check server logs\n- Review pending PRs\n",
        "utf-8",
      );

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

      replySpy.mockResolvedValue({ text: "Checked logs and PRs" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      // Should run and make API call
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("runs heartbeat when HEARTBEAT.md does not exist (lets LLM decide)", async () => {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      // Don't create HEARTBEAT.md - it doesn't exist

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

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      // Should run (not skip) - let LLM decide since file doesn't exist
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });
});
