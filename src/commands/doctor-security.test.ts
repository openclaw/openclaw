import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const channelPlugins = vi.hoisted((): ChannelPlugin[] => []);

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => channelPlugins,
}));

import { noteSecurityWarnings } from "./doctor-security.js";

describe("noteSecurityWarnings gateway exposure", () => {
  let prevToken: string | undefined;
  let prevPassword: string | undefined;

  beforeEach(() => {
    note.mockClear();
    channelPlugins.length = 0;
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

  it("checks non-default channel accounts", async () => {
    channelPlugins.push({
      id: "whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "test",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default", "ops"],
        defaultAccountId: () => "default",
        resolveAccount: (_cfg, accountId) => ({ accountId }),
        isEnabled: () => true,
        isConfigured: (_account, _cfg) => true,
      },
      security: {
        resolveDmPolicy: ({ accountId }) => ({
          policy: accountId === "ops" ? "open" : "disabled",
          allowFrom: accountId === "ops" ? ["*"] : [],
          policyPath: "channels.whatsapp.accounts.<id>.dmPolicy",
          allowFromPath: "channels.whatsapp.accounts.<id>.",
          approveHint: "approve",
        }),
      },
    } as unknown as ChannelPlugin);

    const cfg = {} as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("WhatsApp (ops) DMs: OPEN");
  });
});
