import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import type { HealthSummary } from "./types.js";

type HealthTestPlugin = Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config" | "status">;

let testConfig: OpenClawConfig = {};
let healthPluginsForTest: HealthTestPlugin[] = [];
let collectGatewayHealthSnapshot: (params: {
  audience: "admin";
  probe: boolean;
  timeoutMs: number;
}) => Promise<HealthSummary>;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../../config/config.js", () => ({
    getRuntimeConfig: () => testConfig,
  }));
  vi.doMock("../../config/sessions/paths.js", () => ({
    resolveStorePath: () => "/tmp/health-timeout-sessions.json",
  }));
  vi.doMock("../../config/sessions/session-accessor.js", () => ({
    listSessionEntriesReadOnly: () => [],
  }));
  vi.doMock("../../channels/plugins/read-only.js", () => ({
    listReadOnlyChannelPluginsForConfig: () => healthPluginsForTest,
  }));
  vi.doMock("../../plugins/runtime.js", () => ({
    getActivePluginRegistry: () => null,
  }));
  vi.doMock("../../plugins/runtime-degraded-state.js", () => ({
    degradedPluginMatchesRoot: () => false,
    listActiveDegradedPlugins: () => [],
    toPublicPluginVerificationDiagnostic: vi.fn(),
  }));
  ({ collectGatewayHealthSnapshot } = await import("./collector.js"));
});

beforeEach(() => {
  testConfig = {};
  healthPluginsForTest = [];
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("../../config/config.js");
  vi.doUnmock("../../config/sessions/paths.js");
  vi.doUnmock("../../config/sessions/session-accessor.js");
  vi.doUnmock("../../channels/plugins/read-only.js");
  vi.doUnmock("../../plugins/runtime.js");
  vi.doUnmock("../../plugins/runtime-degraded-state.js");
  vi.resetModules();
});

async function collectHealth(timeoutMs = 100) {
  return await collectGatewayHealthSnapshot({ audience: "admin", probe: true, timeoutMs });
}

describe("collectGatewayHealthSnapshot hook deadlines", () => {
  it("waits for a delayed account hook that settles inside its deadline", async () => {
    vi.useFakeTimers();
    const pluginId = "delayed-summary";
    const account = { accountId: "default", enabled: true, configured: true };
    let markSummaryStarted: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    healthPluginsForTest = [
      {
        ...createChannelTestPluginBase({ id: pluginId, label: pluginId }),
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => account,
          inspectAccount: () => account,
          isConfigured: () => true,
        },
        status: {
          buildChannelSummary: async () => {
            markSummaryStarted?.();
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 75);
            });
            return { configured: true, delayed: true };
          },
        },
      },
    ];

    const run = collectHealth();
    await summaryStarted;
    await vi.advanceTimersByTimeAsync(75);
    const result = (await run).channels[pluginId]?.accounts?.default;

    expect(result).toMatchObject({
      accountId: "default",
      configured: true,
      delayed: true,
    });
    expect(result?.timedOut).toBeUndefined();
  });

  it.each([
    "inspectAccount",
    "isConfigured",
    "buildAccountSnapshot",
    "isLinked",
    "buildChannelSummary",
  ] as const)("returns a partial account when %s never settles", async (phase) => {
    vi.useFakeTimers();
    const pluginId = `timeout-${phase.toLowerCase()}`;
    const account = { accountId: "default", enabled: true, configured: true };
    let release: (() => void) | undefined;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hang = async <T>(value: T): Promise<T> => {
      await hanging;
      return value;
    };
    healthPluginsForTest = [
      {
        ...createChannelTestPluginBase({ id: pluginId, label: pluginId }),
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => account,
          inspectAccount: () => (phase === "inspectAccount" ? hang(account) : account),
          isConfigured: () => (phase === "isConfigured" ? hang(true) : true),
          isLinked: () => (phase === "isLinked" ? hang("linked" as const) : "linked"),
        },
        status: {
          probeAccount: async () => ({ ok: true }),
          buildAccountSnapshot: () =>
            phase === "buildAccountSnapshot" ? hang({ ...account }) : { ...account },
          buildChannelSummary: () =>
            phase === "buildChannelSummary" ? hang({ configured: true }) : { configured: true },
        },
      },
    ];

    const run = collectHealth();
    await vi.advanceTimersByTimeAsync(100);
    const result = (await run).channels[pluginId]?.accounts?.default;

    expect(result).toMatchObject({
      accountId: "default",
      lastError: "Account health timed out after 100ms",
      timedOut: true,
    });
    expect(result?.skipped).toBeUndefined();

    release?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("preserves an immediate account hook error without marking it timed out", async () => {
    const pluginId = "rejected-summary";
    const account = { accountId: "default", enabled: true, configured: true };
    healthPluginsForTest = [
      {
        ...createChannelTestPluginBase({ id: pluginId, label: pluginId }),
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => account,
          inspectAccount: () => account,
          isConfigured: () => true,
        },
        status: {
          buildChannelSummary: async () => {
            throw new Error("summary failed");
          },
        },
      },
    ];

    const result = (await collectHealth()).channels[pluginId]?.accounts?.default;

    expect(result).toMatchObject({
      accountId: "default",
      lastError: "Account health failed: summary failed",
    });
    expect(result?.timedOut).toBeUndefined();
    expect(result?.skipped).toBeUndefined();
  });

  it("keeps timed-out account work inside the five-account capacity", async () => {
    vi.useFakeTimers();
    const accountIds = Array.from({ length: 6 }, (_, index) => `account-${index + 1}`);
    const releases: Array<() => void> = [];
    let started = 0;
    const pluginId = "capacity-test";
    healthPluginsForTest = [
      {
        ...createChannelTestPluginBase({ id: pluginId, label: "Capacity test" }),
        config: {
          listAccountIds: () => accountIds,
          resolveAccount: (_cfg, accountId) => ({
            accountId: accountId ?? "default",
            enabled: true,
            configured: true,
          }),
          inspectAccount: (_cfg, accountId) => ({
            accountId: accountId ?? "default",
            enabled: true,
            configured: true,
          }),
          isConfigured: () => true,
        },
        status: {
          probeAccount: async () => {
            started += 1;
            await new Promise<void>((resolve) => {
              releases.push(resolve);
            });
            return { ok: true };
          },
          buildChannelSummary: ({ snapshot }) => ({ configured: snapshot.configured ?? true }),
        },
      },
    ];

    const run = collectHealth();
    await vi.advanceTimersByTimeAsync(100);
    const accounts = (await run).channels[pluginId]?.accounts;

    expect(started).toBe(5);
    expect(accounts?.["account-6"]).toMatchObject({
      accountId: "account-6",
      skipped: true,
    });
    expect(accounts?.["account-6"]?.timedOut).toBeUndefined();

    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(5);
    for (const release of releases.slice(1)) {
      release();
    }
    await vi.advanceTimersByTimeAsync(0);
  });
});
