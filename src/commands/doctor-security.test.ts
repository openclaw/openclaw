import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const pluginRegistry = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => pluginRegistry.list,
}));

import { noteSecurityWarnings } from "./doctor-security.js";

describe("noteSecurityWarnings gateway exposure", () => {
  let prevToken: string | undefined;
  let prevPassword: string | undefined;

  beforeEach(() => {
    note.mockClear();
    pluginRegistry.list = [];
    prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    prevPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  });

  afterEach(() => {
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
    if (prevPassword === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = prevPassword;
    }
  });

  const lastMessage = () => String(note.mock.calls.at(-1)?.[0] ?? "");

  it("warns when exposed without auth", async () => {
    const cfg = { gateway: { bind: "lan" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("CRITICAL");
    expect(message).toContain("without authentication");
    expect(message).toContain("Safer remote access");
    expect(message).toContain("ssh -N -L 18789:127.0.0.1:18789");
  });

  it("uses env token to avoid critical warning", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-123";
    const cfg = { gateway: { bind: "lan" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("WARNING");
    expect(message).not.toContain("CRITICAL");
  });

  it("treats SecretRef token config as authenticated for exposure warning level", async () => {
    const cfg = {
      gateway: {
        bind: "lan",
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("WARNING");
    expect(message).not.toContain("CRITICAL");
  });

  it("treats whitespace token as missing", async () => {
    const cfg = {
      gateway: { bind: "lan", auth: { mode: "token", token: "   " } },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("CRITICAL");
  });

  it("skips warning for loopback bind", async () => {
    const cfg = { gateway: { bind: "loopback" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain("Gateway bound");
  });

  it("shows explicit dmScope config command for multi-user DMs", async () => {
    pluginRegistry.list = [
      {
        id: "whatsapp",
        meta: { label: "WhatsApp" },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: () => ({
            policy: "allowlist",
            allowFrom: ["alice", "bob"],
            allowFromPath: "channels.whatsapp.",
            approveHint: "approve",
          }),
        },
      },
    ];
    const cfg = { session: { dmScope: "main" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain('config set session.dmScope "per-channel-peer"');
  });

  it("clarifies approvals.exec forwarding-only behavior", async () => {
    const cfg = {
      approvals: {
        exec: {
          enabled: false,
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("disables approval forwarding only");
    expect(message).toContain("exec-approvals.json");
    expect(message).toContain("openclaw approvals get --gateway");
  });

  it("warns when heartbeat delivery relies on implicit directPolicy defaults", async () => {
    const cfg = {
      agents: {
        defaults: {
          heartbeat: {
            target: "last",
          },
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("Heartbeat defaults");
    expect(message).toContain("agents.defaults.heartbeat.directPolicy");
    expect(message).toContain("direct/DM targets by default");
  });

  it("warns when a per-agent heartbeat relies on implicit directPolicy", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "ops",
            heartbeat: {
              target: "last",
            },
          },
        ],
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain('Heartbeat agent "ops"');
    expect(message).toContain('heartbeat.directPolicy for agent "ops"');
    expect(message).toContain("direct/DM targets by default");
  });

  it("degrades safely when channel account resolution fails in read-only security checks", async () => {
    pluginRegistry.list = [
      {
        id: "whatsapp",
        meta: { label: "WhatsApp" },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => {
            throw new Error("missing secret");
          },
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: () => null,
        },
      },
    ];

    await noteSecurityWarnings({} as OpenClawConfig);
    const message = lastMessage();
    expect(message).toContain("[secrets]");
    expect(message).toContain("failed to resolve account");
    expect(message).toContain("Run: openclaw security audit --deep");
  });

  it("skips heartbeat directPolicy warning when delivery is internal-only or explicit", async () => {
    const cfg = {
      agents: {
        defaults: {
          heartbeat: {
            target: "none",
          },
        },
        list: [
          {
            id: "ops",
            heartbeat: {
              target: "last",
              directPolicy: "block",
            },
          },
        ],
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).not.toContain("Heartbeat defaults");
    expect(message).not.toContain('Heartbeat agent "ops"');
  });
});
