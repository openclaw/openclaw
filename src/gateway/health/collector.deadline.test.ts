import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { createSessionStoreSummaryReaderStub } from "../../config/sessions/session-store-summary.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";

type DeadlineAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

let testConfig: OpenClawConfig = {};
let healthPluginsForTest: ChannelPlugin[] = [];
const tempDirs = createTempDirTracker();
let sessionStorePath: string;
const readSessionStoreSummaryReadOnly = vi.fn(() => ({
  count: 0,
  recent: [],
  byAgent: new Map(),
}));
let collectGatewayHealthSnapshot: typeof import("./collector.js").collectGatewayHealthSnapshot;
let createChannelTestPluginBase: typeof import("../../test-utils/channel-plugins.js").createChannelTestPluginBase;

function createDeadlinePlugin(params: {
  accountIds: string[];
  probe: (account: DeadlineAccount) => Promise<Record<string, unknown>>;
}): ChannelPlugin {
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null): DeadlineAccount => ({
    accountId: accountId?.trim() || "default",
    enabled: true,
    configured: true,
  });
  return {
    ...createChannelTestPluginBase({ id: "deadline-test", label: "Deadline Test" }),
    config: {
      listAccountIds: () => params.accountIds,
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (account) => (account as DeadlineAccount).enabled,
      isConfigured: (account) => (account as DeadlineAccount).configured,
    },
    status: {
      probeAccount: async ({ account }) => await params.probe(account as DeadlineAccount),
      buildChannelSummary: ({ snapshot }) => ({ ...snapshot }),
    },
  };
}

async function collectDeadlineSnapshot(params: {
  timeoutMs: number;
  audience?: "public" | "admin";
}) {
  return await collectGatewayHealthSnapshot({
    audience: params.audience ?? "admin",
    probe: true,
    timeoutMs: params.timeoutMs,
  });
}

async function flushHealthPreparation() {
  await vi.advanceTimersByTimeAsync(0);
  // The fake deadline clock does not drive the real yield after a session read.
  await flushImmediate();
}

describe("gateway health collection deadline", () => {
  beforeAll(async () => {
    vi.doMock("../../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
    }));
    vi.doMock("../../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => sessionStorePath,
    }));
    vi.doMock("../../config/sessions/session-entry-read-runtime.js", () => ({
      withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub(
        readSessionStoreSummaryReadOnly,
      ),
    }));
    // mock-isolation: Keep receipt SQLite reads outside the fake-clock health deadline fixture.
    vi.doMock("../../cron/proactive-job-receipt.js", () => ({
      readDefaultProactiveJobsAsync: async () => [],
    }));
    vi.doMock("../../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => healthPluginsForTest,
    }));
    const [health, channelTestUtils] = await Promise.all([
      import("./collector.js"),
      import("../../test-utils/channel-plugins.js"),
    ]);
    collectGatewayHealthSnapshot = health.collectGatewayHealthSnapshot;
    createChannelTestPluginBase = channelTestUtils.createChannelTestPluginBase;
  });

  beforeEach(async () => {
    sessionStorePath = path.join(
      tempDirs.make("openclaw-health-deadline-sessions-"),
      "sessions.json",
    );
    readSessionStoreSummaryReadOnly.mockReset();
    testConfig = {};
    healthPluginsForTest = [];
    await collectGatewayHealthSnapshot({ audience: "admin", probe: false, timeoutMs: 50 });
  });

  afterEach(() => {
    vi.useRealTimers();
    tempDirs.cleanup();
  });

  it("does not start probes when session preparation exhausts the aggregate deadline", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => ({ ok: true }));
    healthPluginsForTest = [createDeadlinePlugin({ accountIds: ["default"], probe })];
    readSessionStoreSummaryReadOnly.mockImplementationOnce(() => {
      vi.advanceTimersByTime(50);
      return { count: 0, recent: [], byAgent: new Map() };
    });

    const snap = await collectDeadlineSnapshot({ timeoutMs: 50 });
    const channel = snap.channels["deadline-test"];

    expect(snap.sessions.path).toBe(
      path.join(path.dirname(sessionStorePath), "openclaw-agent.sqlite"),
    );
    expect(channel?.probe).toEqual({
      timedOut: true,
      error: "health collection timed out after 50ms",
    });
    expect(channel?.accounts?.default?.probe).toEqual({
      timedOut: true,
      error: "health collection timed out after 50ms",
    });
    expect(probe).not.toHaveBeenCalled();
  }, 1_000);

  it.each([
    { audience: "public" as const, channelId: "imessage", retained: true },
    { audience: "public" as const, channelId: "deadline-test", retained: false },
  ])(
    "retains an observed negative through a slow summary ($audience, $channelId)",
    async ({ audience, channelId, retained }) => {
      vi.useFakeTimers();
      const scope = new AsyncWorkScope();
      const enteredSummary = createDeferredCore();
      const releaseSummary = createDeferredCore();
      const error =
        "imsg cannot access /Users/synthetic/Library/Messages/chat.db. Grant Full Disk Access.";
      const plugin = createDeadlinePlugin({
        accountIds: ["default"],
        probe: async () => ({ ok: false, error }),
      });
      healthPluginsForTest = [
        {
          ...plugin,
          id: channelId,
          status: {
            ...plugin.status,
            buildChannelSummary: async ({ snapshot }) => {
              enteredSummary.resolve();
              await releaseSummary.promise;
              return { ...snapshot };
            },
          },
        },
      ];
      const collecting = scope.track(() => collectDeadlineSnapshot({ timeoutMs: 50, audience }));
      try {
        await flushHealthPreparation();
        await enteredSummary.promise;
        await vi.advanceTimersByTimeAsync(50);
        const result = await collecting;
        expect(result.channels[channelId]?.probe).toEqual(
          retained
            ? {
                ok: false,
                error:
                  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
              }
            : { timedOut: true, error: "health collection timed out after 50ms" },
        );
        expect(JSON.stringify(result)).not.toContain("/Users/synthetic");
      } finally {
        releaseSummary.resolve();
        await scope.drain();
        await collecting;
      }
    },
  );

  it("preserves healthy accounts at the deadline and retains unfinished probe work", async () => {
    vi.useFakeTimers();
    const scope = new AsyncWorkScope();
    const slowProbe = createDeferredCore<Record<string, unknown>>();
    const accountIds = ["default", "fast-1", "fast-2", "fast-3", "fast-4", "fast-5"];
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    let snapshotPromise: ReturnType<typeof collectDeadlineSnapshot> | undefined;
    let draining: Promise<void> | undefined;
    healthPluginsForTest = [
      createDeadlinePlugin({
        accountIds,
        probe: async (account) => {
          started.push(account.accountId);
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (account.accountId === "default") {
            try {
              return await slowProbe.promise;
            } finally {
              active -= 1;
            }
          }
          await Promise.resolve();
          active -= 1;
          return { ok: true, accountId: account.accountId };
        },
      }),
    ];

    try {
      snapshotPromise = scope.track(() => collectDeadlineSnapshot({ timeoutMs: 50 }));
      await flushHealthPreparation();
      await vi.advanceTimersByTimeAsync(50);
      const snap = await snapshotPromise;
      const channel = snap.channels["deadline-test"];

      expect(started).toEqual(accountIds);
      expect(maxActive).toBeLessThanOrEqual(5);
      expect(channel?.probe).toEqual({
        timedOut: true,
        error: "health collection timed out after 50ms",
      });
      for (const accountId of accountIds.slice(1)) {
        expect(channel?.accounts?.[accountId]?.probe).toMatchObject({ ok: true });
      }
      let drained = false;
      draining = scope.drain().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);
      slowProbe.resolve({ ok: true });
      await draining;
      expect(active).toBe(0);
    } finally {
      slowProbe.resolve({ ok: true });
      await Promise.allSettled([snapshotPromise, slowProbe.promise]);
      await (draining ?? scope.drain());
      await vi.advanceTimersByTimeAsync(0);
    }
  }, 1_000);

  it("does not start queued probes after the aggregate deadline", async () => {
    vi.useFakeTimers();
    const accountIds = [
      "default",
      "blocked-1",
      "blocked-2",
      "blocked-3",
      "blocked-4",
      "queued-1",
      "queued-2",
    ];
    const started: string[] = [];
    const releaseProbes: Array<() => void> = [];
    healthPluginsForTest = [
      createDeadlinePlugin({
        accountIds,
        probe: async (account) => {
          started.push(account.accountId);
          return await new Promise<Record<string, unknown>>((resolve) => {
            releaseProbes.push(() => resolve({ ok: true }));
          });
        },
      }),
    ];

    const snapshotPromise = collectDeadlineSnapshot({ timeoutMs: 50, audience: "public" });
    try {
      await flushHealthPreparation();
      expect(started).toEqual(accountIds.slice(0, 5));
      await vi.advanceTimersByTimeAsync(50);
      const snap = await snapshotPromise;
      const channel = snap.channels["deadline-test"];

      expect(started).toEqual(accountIds.slice(0, 5));
      for (const accountId of accountIds) {
        expect(channel?.accounts?.[accountId]?.probe).toEqual({
          error: "health collection timed out after 50ms",
          timedOut: true,
        });
      }
    } finally {
      for (const release of releaseProbes) {
        release();
      }
      await vi.advanceTimersByTimeAsync(50);
      await snapshotPromise;
    }
  }, 1_000);

  it("retains timed-out permits across repeated health collections", async () => {
    vi.useFakeTimers();
    const accountIds = ["default", "blocked-1", "blocked-2", "blocked-3", "blocked-4"];
    const started: string[] = [];
    const releaseProbes: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    healthPluginsForTest = [
      createDeadlinePlugin({
        accountIds,
        probe: async (account) => {
          started.push(account.accountId);
          active += 1;
          maxActive = Math.max(maxActive, active);
          return await new Promise<Record<string, unknown>>((resolve) => {
            releaseProbes.push(() => {
              active -= 1;
              resolve({ ok: true });
            });
          });
        },
      }),
    ];

    const firstSnapshot = collectDeadlineSnapshot({ timeoutMs: 50 });
    try {
      await flushHealthPreparation();
      expect(started).toEqual(accountIds);
      await vi.advanceTimersByTimeAsync(50);
      await firstSnapshot;

      const secondSnapshot = collectDeadlineSnapshot({ timeoutMs: 50 });
      await flushHealthPreparation();
      expect(started).toEqual(accountIds);
      await vi.advanceTimersByTimeAsync(50);
      const second = await secondSnapshot;

      expect(started).toEqual(accountIds);
      expect(active).toBe(5);
      expect(maxActive).toBe(5);
      for (const accountId of accountIds) {
        expect(second.channels["deadline-test"]?.accounts?.[accountId]?.probe).toEqual({
          error: "health collection timed out after 50ms",
          timedOut: true,
        });
      }
    } finally {
      for (const release of releaseProbes) {
        release();
      }
      await vi.advanceTimersByTimeAsync(50);
      await firstSnapshot;
    }
    expect(active).toBe(0);
  }, 1_000);
});
