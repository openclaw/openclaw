import { spawn } from "node:child_process";
import * as net from "node:net";
import { afterAll, afterEach, beforeEach, vi } from "vitest";

// Ensure Vitest environment is properly set
process.env.VITEST = "true";

// Default to disabled to avoid race conditions in setup ordering.
(globalThis as { __OPENCLAW_CAN_LISTEN__?: boolean }).__OPENCLAW_CAN_LISTEN__ = false;
process.env.OPENCLAW_TEST_CAN_LISTEN = "0";

const canListenOnLoopback = await new Promise<boolean>((resolve) => {
  const server = net.createServer();
  server.once("error", (err) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    resolve(code !== "EPERM");
  });
  server.listen(0, "127.0.0.1", () => {
    server.close(() => resolve(true));
  });
});

(globalThis as { __OPENCLAW_CAN_LISTEN__?: boolean }).__OPENCLAW_CAN_LISTEN__ = canListenOnLoopback;
process.env.OPENCLAW_TEST_CAN_LISTEN = canListenOnLoopback ? "1" : "0";

let canPty = false;
try {
  const pty = await import("@lydell/node-pty");
  canPty = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(ok);
    };
    try {
      const proc = pty.spawn(process.execPath, ["-e", "process.exit(0)"], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
      });
      if ("onExit" in proc && typeof proc.onExit === "function") {
        proc.onExit((evt: { exitCode: number }) => finish(evt.exitCode === 0));
      } else if ("on" in proc && typeof proc.on === "function") {
        proc.on("exit", (code: number) => finish(code === 0));
        proc.on("error", () => finish(false));
      } else {
        finish(false);
      }
    } catch {
      finish(false);
    }
  });
} catch {
  canPty = false;
}

(globalThis as { __OPENCLAW_CAN_PTY__?: boolean }).__OPENCLAW_CAN_PTY__ = canPty;
process.env.OPENCLAW_TEST_CAN_PTY = canPty ? "1" : "0";

const canCaptureChildOutput = await new Promise<boolean>((resolve) => {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ok")'], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.once("error", () => resolve(false));
  child.once("close", () => resolve(output === "ok"));
});

(
  globalThis as { __OPENCLAW_CAN_CAPTURE_CHILD_OUTPUT__?: boolean }
).__OPENCLAW_CAN_CAPTURE_CHILD_OUTPUT__ = canCaptureChildOutput;
process.env.OPENCLAW_TEST_CAN_CAPTURE_CHILD_OUTPUT = canCaptureChildOutput ? "1" : "0";

import type {
  ChannelId,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../src/config/config.js";
import type { OutboundSendDeps } from "../src/infra/outbound/deliver.js";
import { installProcessWarningFilter } from "../src/infra/warning-filter.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withIsolatedTestHome } from "./test-env.js";

installProcessWarningFilter();

const testEnv = withIsolatedTestHome();
afterAll(() => testEnv.cleanup());
const pickSendFn = (id: ChannelId, deps?: OutboundSendDeps) => {
  switch (id) {
    case "discord":
      return deps?.sendDiscord;
    case "slack":
      return deps?.sendSlack;
    case "telegram":
      return deps?.sendTelegram;
    case "whatsapp":
      return deps?.sendWhatsApp;
    case "signal":
      return deps?.sendSignal;
    case "imessage":
      return deps?.sendIMessage;
    default:
      return undefined;
  }
};

const createStubOutbound = (
  id: ChannelId,
  deliveryMode: ChannelOutboundAdapter["deliveryMode"] = "direct",
): ChannelOutboundAdapter => ({
  deliveryMode,
  sendText: async ({ deps, to, text }) => {
    const send = pickSendFn(id, deps);
    if (send) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await send(to, text, { verbose: false } as any);
      return { channel: id, ...result };
    }
    return { channel: id, messageId: "test" };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    const send = pickSendFn(id, deps);
    if (send) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await send(to, text, { verbose: false, mediaUrl } as any);
      return { channel: id, ...result };
    }
    return { channel: id, messageId: "test" };
  },
});

const createStubPlugin = (params: {
  id: ChannelId;
  label?: string;
  aliases?: string[];
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
  preferSessionLookupForAnnounceTarget?: boolean;
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
    aliases: params.aliases,
    preferSessionLookupForAnnounceTarget: params.preferSessionLookupForAnnounceTarget,
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: (cfg: OpenClawConfig) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      const entry = channels?.[params.id];
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const accounts = (entry as { accounts?: Record<string, unknown> }).accounts;
      const ids = accounts ? Object.keys(accounts).filter(Boolean) : [];
      return ids.length > 0 ? ids : ["default"];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      const entry = channels?.[params.id];
      if (!entry || typeof entry !== "object") {
        return {};
      }
      const accounts = (entry as { accounts?: Record<string, unknown> }).accounts;
      const match = accountId ? accounts?.[accountId] : undefined;
      return (match && typeof match === "object") || typeof match === "string" ? match : entry;
    },
    isConfigured: async (_account, cfg: OpenClawConfig) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      return Boolean(channels?.[params.id]);
    },
  },
  outbound: createStubOutbound(params.id, params.deliveryMode),
});

const createDefaultRegistry = () =>
  createTestRegistry([
    {
      pluginId: "discord",
      plugin: createStubPlugin({ id: "discord", label: "Discord" }),
      source: "test",
    },
    {
      pluginId: "slack",
      plugin: createStubPlugin({ id: "slack", label: "Slack" }),
      source: "test",
    },
    {
      pluginId: "telegram",
      plugin: {
        ...createStubPlugin({ id: "telegram", label: "Telegram" }),
        status: {
          buildChannelSummary: async () => ({
            configured: false,
            tokenSource: process.env.TELEGRAM_BOT_TOKEN ? "env" : "none",
          }),
        },
      },
      source: "test",
    },
    {
      pluginId: "whatsapp",
      plugin: createStubPlugin({
        id: "whatsapp",
        label: "WhatsApp",
        deliveryMode: "gateway",
        preferSessionLookupForAnnounceTarget: true,
      }),
      source: "test",
    },
    {
      pluginId: "signal",
      plugin: createStubPlugin({ id: "signal", label: "Signal" }),
      source: "test",
    },
    {
      pluginId: "imessage",
      plugin: createStubPlugin({ id: "imessage", label: "iMessage", aliases: ["imsg"] }),
      source: "test",
    },
  ]);

beforeEach(() => {
  setActivePluginRegistry(createDefaultRegistry());
});

afterEach(() => {
  setActivePluginRegistry(createDefaultRegistry());
  // Guard against leaked fake timers across test files/workers.
  vi.useRealTimers();
});
