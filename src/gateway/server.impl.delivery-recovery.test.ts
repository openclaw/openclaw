import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ChannelManager } from "./server-channels.js";

const hoisted = vi.hoisted(() => ({
  normalizeChannelId: vi.fn<(raw?: string | null) => string | null>(),
  getChannelPlugin: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: hoisted.normalizeChannelId,
  getChannelPlugin: hoisted.getChannelPlugin,
  listChannelPlugins: vi.fn(() => []),
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: hoisted.resolveChannelDefaultAccountId,
}));

import { __testing } from "./server.impl.js";

type RuntimeAccount = {
  enabled?: boolean;
  configured?: boolean;
  running?: boolean;
  connected?: boolean;
};

type RuntimeSnapshot = {
  channels: Record<string, unknown>;
  channelAccounts: Record<string, Record<string, RuntimeAccount>>;
};

function createSnapshot(params: {
  channel: string;
  accountId: string;
  account: RuntimeAccount;
}): RuntimeSnapshot {
  return {
    channels: {},
    channelAccounts: {
      [params.channel]: {
        [params.accountId]: params.account,
      },
    },
  };
}

function createChannelManager(snapshots: RuntimeSnapshot[]): ChannelManager {
  let index = 0;
  const getRuntimeSnapshot = vi.fn(() => snapshots[Math.min(index++, snapshots.length - 1)]);
  return { getRuntimeSnapshot } as unknown as ChannelManager;
}

type RecoveryPreflightLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type TestLog = RecoveryPreflightLog & {
  infoMock: ReturnType<typeof vi.fn<(msg: string) => void>>;
  warnMock: ReturnType<typeof vi.fn<(msg: string) => void>>;
};

function createTestLog(): TestLog {
  const infoMock = vi.fn<(msg: string) => void>();
  const warnMock = vi.fn<(msg: string) => void>();
  return {
    info: infoMock,
    warn: warnMock,
    infoMock,
    warnMock,
  };
}

beforeEach(() => {
  hoisted.normalizeChannelId.mockReset();
  hoisted.getChannelPlugin.mockReset();
  hoisted.resolveChannelDefaultAccountId.mockReset();

  hoisted.normalizeChannelId.mockImplementation((raw?: string | null) => {
    if (typeof raw !== "string") {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  });
});

describe("delivery recovery target resolution", () => {
  it("skips legacy entries without accountId when channel has no configured accounts", () => {
    hoisted.getChannelPlugin.mockReturnValue({
      id: "synologychat",
      config: {
        listAccountIds: () => [],
      },
    });
    hoisted.resolveChannelDefaultAccountId.mockReturnValue("default");

    const targets = __testing.resolvePendingDeliveryRecoveryTargets({
      pending: [{ channel: "synologychat" }],
      cfg: {} as OpenClawConfig,
    });

    expect(targets).toEqual([]);
  });

  it("uses configured default account for legacy entries when accounts exist", () => {
    hoisted.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      config: {
        listAccountIds: () => ["default", "backup"],
      },
    });
    hoisted.resolveChannelDefaultAccountId.mockReturnValue("default");

    const targets = __testing.resolvePendingDeliveryRecoveryTargets({
      pending: [{ channel: "whatsapp" }],
      cfg: {} as OpenClawConfig,
    });

    expect(targets).toEqual([{ channel: "whatsapp", accountId: "default" }]);
  });

  it("skips explicit stale account ids removed from config", () => {
    hoisted.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      config: {
        listAccountIds: () => ["live"],
      },
    });

    const targets = __testing.resolvePendingDeliveryRecoveryTargets({
      pending: [{ channel: "whatsapp", accountId: "removed" }],
      cfg: {} as OpenClawConfig,
    });

    expect(targets).toEqual([]);
  });
});

describe("delivery recovery preflight skip mode", () => {
  it("skips readiness preflight when OPENCLAW_SKIP_CHANNELS is enabled", () => {
    expect(
      __testing.shouldSkipDeliveryRecoveryReadinessPreflight({ OPENCLAW_SKIP_CHANNELS: "1" }),
    ).toBe(true);
  });

  it("skips readiness preflight when OPENCLAW_SKIP_PROVIDERS is enabled", () => {
    expect(
      __testing.shouldSkipDeliveryRecoveryReadinessPreflight({ OPENCLAW_SKIP_PROVIDERS: "true" }),
    ).toBe(true);
  });

  it("does not skip readiness preflight when both flags are disabled", () => {
    expect(
      __testing.shouldSkipDeliveryRecoveryReadinessPreflight({
        OPENCLAW_SKIP_CHANNELS: "0",
        OPENCLAW_SKIP_PROVIDERS: "false",
      }),
    ).toBe(false);
  });
});

describe("waitForPendingDeliveryChannelReadiness", () => {
  it("waits until WhatsApp is both running and connected", async () => {
    const channelManager = createChannelManager([
      createSnapshot({
        channel: "whatsapp",
        accountId: "default",
        account: { enabled: true, configured: true, running: true, connected: false },
      }),
      createSnapshot({
        channel: "whatsapp",
        accountId: "default",
        account: { enabled: true, configured: true, running: true, connected: true },
      }),
    ]);
    const log = createTestLog();

    await __testing.waitForPendingDeliveryChannelReadiness({
      channelManager,
      targets: [{ channel: "whatsapp", accountId: "default" }],
      log,
      timeoutMs: 500,
      pollMs: 50,
    });

    expect(log.warnMock).not.toHaveBeenCalled();
    expect(log.infoMock).toHaveBeenCalledWith(
      expect.stringContaining("Recovery preflight complete: runtime ready"),
    );
  });

  it("times out and continues when readiness does not arrive", async () => {
    const channelManager = createChannelManager([
      createSnapshot({
        channel: "whatsapp",
        accountId: "default",
        account: { enabled: true, configured: true, running: false, connected: false },
      }),
    ]);
    const log = createTestLog();

    await __testing.waitForPendingDeliveryChannelReadiness({
      channelManager,
      targets: [{ channel: "whatsapp", accountId: "default" }],
      log,
      timeoutMs: 60,
      pollMs: 50,
    });

    expect(log.warnMock).toHaveBeenCalledWith(
      expect.stringContaining("Recovery preflight timeout"),
    );
  });

  it("aborts promptly when shutdown signal is triggered", async () => {
    const channelManager = createChannelManager([
      createSnapshot({
        channel: "whatsapp",
        accountId: "default",
        account: { enabled: true, configured: true, running: false, connected: false },
      }),
    ]);
    const log = createTestLog();
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 15);

    await expect(
      __testing.waitForPendingDeliveryChannelReadiness({
        channelManager,
        targets: [{ channel: "whatsapp", accountId: "default" }],
        log,
        timeoutMs: 5_000,
        pollMs: 50,
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("treats disabled/unconfigured accounts as non-blocking", async () => {
    const channelManager = createChannelManager([
      createSnapshot({
        channel: "whatsapp",
        accountId: "default",
        account: { enabled: false, configured: false, running: false, connected: false },
      }),
    ]);
    const log = createTestLog();

    await __testing.waitForPendingDeliveryChannelReadiness({
      channelManager,
      targets: [{ channel: "whatsapp", accountId: "default" }],
      log,
      timeoutMs: 500,
      pollMs: 50,
    });

    expect(log.warnMock).not.toHaveBeenCalled();
  });

  it("does not require connected=true for non-WhatsApp channels", async () => {
    const channelManager = createChannelManager([
      createSnapshot({
        channel: "discord",
        accountId: "default",
        account: { enabled: true, configured: true, running: true, connected: false },
      }),
    ]);
    const log = createTestLog();

    await __testing.waitForPendingDeliveryChannelReadiness({
      channelManager,
      targets: [{ channel: "discord", accountId: "default" }],
      log,
      timeoutMs: 500,
      pollMs: 50,
    });

    expect(log.warnMock).not.toHaveBeenCalled();
    expect(log.infoMock).toHaveBeenCalledWith(
      expect.stringContaining("Recovery preflight complete: runtime ready"),
    );
  });
});
