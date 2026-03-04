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

  it("warns for all accounts, not just the default", async () => {
    pluginRegistry.list = [
      {
        id: "discord",
        meta: { label: "Discord" },
        config: {
          listAccountIds: () => ["default", "work-bot"],
          resolveAccount: (_cfg: unknown, accountId: string) => {
            if (accountId === "work-bot") {
              return {
                accountId: "work-bot",
                config: { dm: { policy: "open", allowFrom: ["*"] } },
              };
            }
            return {
              accountId: "default",
              config: { dm: { policy: "pairing", allowFrom: [] } },
            };
          },
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: ({
            accountId,
            account,
          }: {
            cfg: unknown;
            accountId: string;
            account: { config: { dm: { policy: string; allowFrom: string[] } } };
          }) => ({
            policy: account.config.dm.policy,
            allowFrom: account.config.dm.allowFrom,
            allowFromPath: `channels.discord.accounts.${accountId}.dm.`,
            approveHint: "approve via pairing",
          }),
        },
      },
    ];
    const cfg = {} as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    // The "work-bot" account has dmPolicy="open", which should be warned about
    expect(message).toContain("Discord (work-bot)");
    expect(message).toContain("OPEN");
    // The "default" account should also appear with its pairing policy info
    expect(message).toContain("Discord (default)");
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
});
