import "./test-helpers.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { WebInboundMessage } from "./inbound.js";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import * as ssrf from "../infra/net/ssrf.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import {
  resetBaileysMocks as _resetBaileysMocks,
  resetLoadConfigMock as _resetLoadConfigMock,
} from "./test-helpers.js";

export { resetBaileysMocks, resetLoadConfigMock, setLoadConfigMock } from "./test-helpers.js";

export const TEST_NET_IP = "203.0.113.10";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

export async function rmDirWithRetries(
  dir: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = opts?.attempts ?? 10;
  const delayMs = opts?.delayMs ?? 5;
  // Some tests can leave async session-store writes in-flight; recursive deletion can race and throw ENOTEMPTY.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
}

let previousHome: string | undefined;
let tempHome: string | undefined;

export function installWebAutoReplyTestHomeHooks() {
  beforeEach(async () => {
    resetInboundDedupe();
    previousHome = process.env.HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-web-home-"));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    if (tempHome) {
      await rmDirWithRetries(tempHome);
      tempHome = undefined;
    }
  });
}

export async function makeSessionStore(
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-"));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries));
  const cleanup = async () => {
    await rmDirWithRetries(dir);
  };
  return {
    storePath,
    cleanup,
  };
}

export function installWebAutoReplyUnitTestHooks(opts?: { pinDns?: boolean }) {
  let resolvePinnedHostnameSpy: { mockRestore: () => unknown } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetBaileysMocks();
    _resetLoadConfigMock();
    if (opts?.pinDns) {
      resolvePinnedHostnameSpy = vi
        .spyOn(ssrf, "resolvePinnedHostname")
        .mockImplementation(async (hostname) => {
          // SSRF guard pins DNS; stub resolution to avoid live lookups in unit tests.
          const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
          const addresses = [TEST_NET_IP];
          return {
            hostname: normalized,
            addresses,
            lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
          };
        });
    }
  });

  afterEach(() => {
    resolvePinnedHostnameSpy?.mockRestore();
    resolvePinnedHostnameSpy = undefined;
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });
}

export function createWebListenerFactoryCapture() {
  let capturedOnMessage: ((msg: WebInboundMessage) => Promise<void>) | undefined;
  const listenerFactory = async (opts: {
    onMessage: (msg: WebInboundMessage) => Promise<void>;
  }) => {
    capturedOnMessage = opts.onMessage;
    return { close: vi.fn() };
  };

  return {
    listenerFactory,
    getOnMessage: () => capturedOnMessage,
  };
}

export function createWebInboundDeliverySpies() {
  return {
    sendMedia: vi.fn(),
    reply: vi.fn().mockResolvedValue(undefined),
    sendComposing: vi.fn(),
  };
}

export async function sendWebGroupInboundMessage(params: {
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  body: string;
  id: string;
  senderE164: string;
  senderName: string;
  mentionedJids?: string[];
  selfE164?: string;
  selfJid?: string;
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  conversationId?: string;
  accountId?: string;
}) {
  const conversationId = params.conversationId ?? "123@g.us";
  const accountId = params.accountId ?? "default";
  await params.onMessage({
    body: params.body,
    from: conversationId,
    conversationId,
    chatId: conversationId,
    chatType: "group",
    to: "+2",
    accountId,
    id: params.id,
    senderE164: params.senderE164,
    senderName: params.senderName,
    mentionedJids: params.mentionedJids,
    selfE164: params.selfE164,
    selfJid: params.selfJid,
    sendComposing: params.spies.sendComposing,
    reply: params.spies.reply,
    sendMedia: params.spies.sendMedia,
  } as WebInboundMessage);
}
