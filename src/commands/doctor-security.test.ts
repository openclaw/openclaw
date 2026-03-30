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
  let prevSkipAuthWarning: string | undefined;

  beforeEach(() => {
    note.mockClear();
    pluginRegistry.list = [];
    prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    prevPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    prevSkipAuthWarning = process.env.OPENCLAW_SKIP_AUTH_WARNING;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_SKIP_AUTH_WARNING;
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
    if (prevSkipAuthWarning === undefined) {
      delete process.env.OPENCLAW_SKIP_AUTH_WARNING;
    } else {
      process.env.OPENCLAW_SKIP_AUTH_WARNING = prevSkipAuthWarning;
    }
  });

  const lastMessage = () => String(note.mock.calls.at(-1)?.[0] ?? "");

  it("warns when auth is disabled on a wildcard bind", async () => {
    const cfg = { gateway: { bind: "lan", auth: { mode: "none" } } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("CRITICAL");
    expect(message).toContain("without authentication");
    expect(message).toContain("config set gateway.bind loopback");
    expect(message).toContain("config set gateway.auth.mode token");
  });

  it("does not warn when auth is enabled via env token", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-123";
    const cfg = { gateway: { bind: "lan" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain("Gateway bound");
  });

  it("does not warn when token auth is configured through SecretRef", async () => {
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
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain("Gateway bound");
  });

  it("does not warn when auth mode is token, even if token is invalid", async () => {
    const cfg = {
      gateway: { bind: "lan", auth: { mode: "token", token: "   " } },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain("Gateway bound");
  });

  it("skips warning for loopback bind", async () => {
    const cfg = { gateway: { bind: "loopback" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain("Gateway bound");
  });

  it("suppresses gateway auth exposure warning when override env is set", async () => {
    process.env.OPENCLAW_SKIP_AUTH_WARNING = "true";
    const cfg = { gateway: { bind: "lan", auth: { mode: "none" } } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain("without authentication");
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
