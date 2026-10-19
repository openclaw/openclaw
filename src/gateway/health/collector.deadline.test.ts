import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
type Probe = (account: DeadlineAccount) => Promise<Record<string, unknown>>;

let testConfig: OpenClawConfig = {};
let healthPluginsForTest: ChannelPlugin[] = [];
const tempDirs = createTempDirTracker();
let sessionStorePath: string;
const emptySummary = () => ({ count: 0, recent: [], byAgent: new Map() });
const readSummary = vi.fn(emptySummary);
let collectGatewayHealthSnapshot: typeof import("./collector.js").collectGatewayHealthSnapshot;
let createChannelTestPluginBase: typeof import("../../test-utils/channel-plugins.js").createChannelTestPluginBase;
const timeoutProbe = { timedOut: true, error: "health collection timed out after 7000ms" };
const blockedAccounts = ["default", "blocked-1", "blocked-2", "blocked-3", "blocked-4"];
let scope: AsyncWorkScope;
const cleanup: Array<() => void> = [];

function hold<T>(value: T) {
  const deferred = createDeferredCore<T>();
  cleanup.push(() => deferred.resolve(value));
  return deferred;
}

function installProbe(accountIds: string[], probe: Probe, id = "deadline-test") {
  const started: string[] = [];
  const work = { started, active: 0, maxActive: 0 };
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null): DeadlineAccount => ({
    accountId: accountId?.trim() || "default",
    enabled: true,
    configured: true,
  });
  const plugin: ChannelPlugin<DeadlineAccount> = {
    ...createChannelTestPluginBase({ id, label: "Deadline Test" }),
    config: {
      listAccountIds: () => accountIds,
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
    },
    status: {
      probeAccount: async ({ account }) => {
        started.push(account.accountId);
        work.maxActive = Math.max(work.maxActive, ++work.active);
        try {
          return await probe(account);
        } finally {
          work.active -= 1;
        }
      },
      buildChannelSummary: ({ snapshot }) => ({ ...snapshot }),
    },
  };
  healthPluginsForTest = [plugin];
  return { work, plugin };
}

async function collectDeadlineSnapshot(audience: "public" | "admin" = "admin") {
  return await scope.track(() => collectGatewayHealthSnapshot({ audience, probe: true }));
}

function installBlockedProbes(accountIds: string[]) {
  const blocked = hold<Record<string, unknown>>({ ok: true });
  const { work } = installProbe(accountIds, () => blocked.promise);
  return { work, release: () => blocked.resolve({ ok: true }) };
}

async function flushHealthPreparation() {
  await vi.advanceTimersByTimeAsync(0);
  // The fake deadline clock does not drive the real yield after a session read.
  await flushImmediate();
}

beforeAll(async () => {
  vi.doMock("../../config/config.js", () => ({
    getRuntimeConfig: () => testConfig,
  }));
  vi.doMock("../../config/sessions/paths.js", () => ({
    resolveSessionStorePathCore: () => sessionStorePath,
  }));
  // mock-isolation: control worker-read completion independently of the health deadline clock.
  vi.doMock("../../config/sessions/session-entry-read-runtime.js", () => ({
    withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub(readSummary),
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
  scope = new AsyncWorkScope();
  sessionStorePath = path.join(
    tempDirs.make("openclaw-health-deadline-sessions-"),
    "sessions.json",
  );
  readSummary.mockReset();
  testConfig = {};
  healthPluginsForTest = [];
  await collectGatewayHealthSnapshot({ audience: "admin", probe: false });
});

afterEach(async () => {
  for (const release of cleanup.splice(0)) {
    release();
  }
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(7_000);
  }
  await scope.drain();
  vi.useRealTimers();
  tempDirs.cleanup();
});

it("does not start probes when session preparation exhausts the aggregate deadline", async () => {
  vi.useFakeTimers();
  const probe = vi.fn(async () => ({ ok: true }));
  installProbe(["default"], probe);
  readSummary.mockImplementationOnce(() => {
    vi.advanceTimersByTime(7_000);
    return emptySummary();
  });

  const snap = await collectDeadlineSnapshot();
  const channel = snap.channels["deadline-test"];

  const sqlitePath = path.join(path.dirname(sessionStorePath), "openclaw-agent.sqlite");
  expect(snap.sessions.path).toBe(sqlitePath);
  expect(channel?.probe).toEqual(timeoutProbe);
  expect(channel?.accounts?.default?.probe).toEqual(timeoutProbe);
  expect(probe).not.toHaveBeenCalled();
}, 1_000);

it.each(["imessage", "deadline-test"])(
  "retains only safe public negatives through a slow %s summary",
  async (channelId) => {
    vi.useFakeTimers();
    const enteredSummary = createDeferredCore();
    const releaseSummary = hold(undefined);
    const error =
      "imsg cannot access /Users/synthetic/Library/Messages/chat.db. Grant Full Disk Access.";
    const { plugin } = installProbe(["default"], async () => ({ ok: false, error }), channelId);
    plugin.status = {
      ...plugin.status,
      buildChannelSummary: async ({ snapshot }) => {
        enteredSummary.resolve();
        await releaseSummary.promise;
        return { ...snapshot };
      },
    };
    const collecting = collectDeadlineSnapshot("public");
    await flushHealthPreparation();
    await enteredSummary.promise;
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await collecting;
    expect(result.channels[channelId]?.probe).toEqual(
      channelId === "imessage"
        ? {
            ok: false,
            error:
              "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
          }
        : timeoutProbe,
    );
    expect(JSON.stringify(result)).not.toContain("/Users/synthetic");
  },
);

it("preserves healthy accounts at the deadline and retains unfinished probe work", async () => {
  vi.useFakeTimers();
  const slowProbe = hold<Record<string, unknown>>({ ok: true });
  const accountIds = ["default", "fast-1", "fast-2", "fast-3", "fast-4", "fast-5"];
  const { work } = installProbe(accountIds, async (account) => {
    if (account.accountId === "default") {
      return await slowProbe.promise;
    }
    await Promise.resolve();
    return { ok: true, accountId: account.accountId };
  });

  const snapshotPromise = collectDeadlineSnapshot();
  await flushHealthPreparation();
  await vi.advanceTimersByTimeAsync(7_000);
  const snap = await snapshotPromise;
  const channel = snap.channels["deadline-test"];

  expect(work.started).toEqual(accountIds);
  expect(work.maxActive).toBeLessThanOrEqual(5);
  expect(channel?.probe).toEqual(timeoutProbe);
  for (const accountId of accountIds.slice(1)) {
    expect(channel?.accounts?.[accountId]?.probe).toMatchObject({ ok: true });
  }
  let drained = false;
  const draining = scope.drain().then(() => {
    drained = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(drained).toBe(false);
  slowProbe.resolve({ ok: true });
  await draining;
  expect(work.active).toBe(0);
}, 1_000);

it("does not start queued probes after the aggregate deadline", async () => {
  vi.useFakeTimers();
  const accountIds = [...blockedAccounts, "queued-1", "queued-2"];
  const { work } = installBlockedProbes(accountIds);

  const snapshotPromise = collectDeadlineSnapshot("public");
  await flushHealthPreparation();
  expect(work.started).toEqual(accountIds.slice(0, 5));
  await vi.advanceTimersByTimeAsync(7_000);
  const snap = await snapshotPromise;
  const channel = snap.channels["deadline-test"];

  expect(work.started).toEqual(accountIds.slice(0, 5));
  for (const accountId of accountIds) {
    expect(channel?.accounts?.[accountId]?.probe).toEqual(timeoutProbe);
  }
}, 1_000);

it.each([60_000, -60_000])(
  "keeps the 7s budget when the wall clock steps %s ms",
  async (stepMs) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    const slowProbe = hold<Record<string, unknown>>({ ok: true });
    installProbe(["default"], async () => (stepMs > 0 ? { ok: true } : await slowProbe.promise));
    readSummary.mockImplementation(() => {
      // setSystemTime moves only Date; performance.now() keeps monotonic time.
      vi.setSystemTime(Date.now() + stepMs);
      return emptySummary();
    });

    const snapshotPromise = collectDeadlineSnapshot();
    await flushHealthPreparation();
    await vi.advanceTimersByTimeAsync(7_000);
    const snap = await snapshotPromise;
    slowProbe.resolve({ ok: true });

    expect(snap.channels["deadline-test"]?.accounts?.default?.probe).toEqual(
      stepMs > 0 ? { ok: true } : timeoutProbe,
    );
  },
  1_000,
);

it("retains timed-out permits across repeated health collections", async () => {
  vi.useFakeTimers();
  const accountIds = blockedAccounts;
  const { work, release } = installBlockedProbes(accountIds);

  const firstSnapshot = collectDeadlineSnapshot();
  await flushHealthPreparation();
  expect(work.started).toEqual(accountIds);
  await vi.advanceTimersByTimeAsync(7_000);
  await firstSnapshot;

  const secondSnapshot = collectDeadlineSnapshot();
  await flushHealthPreparation();
  expect(work.started).toEqual(accountIds);
  await vi.advanceTimersByTimeAsync(7_000);
  const second = await secondSnapshot;

  expect(work.started).toEqual(accountIds);
  expect(work).toMatchObject({ active: 5, maxActive: 5 });
  for (const accountId of accountIds) {
    expect(second.channels["deadline-test"]?.accounts?.[accountId]?.probe).toEqual(timeoutProbe);
  }
  release();
  await vi.advanceTimersByTimeAsync(7_000);
  await firstSnapshot;
  expect(work.active).toBe(0);
}, 1_000);
