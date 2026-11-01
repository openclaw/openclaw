import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { createSessionStoreSummaryReaderStub } from "../../config/sessions/session-store-summary.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";

type DeadlineAccount = { accountId: string };
type Probe = (account: DeadlineAccount) => Promise<Record<string, unknown>>;

let testConfig: OpenClawConfig = {};
let healthPluginsForTest: ChannelPlugin[] = [];
const tempDirs = createTempDirTracker();
let sessionStorePath: string;
const emptySummary = () => ({ count: 0, recent: [], byAgent: new Map() });
const readSummary = vi.fn(emptySummary);
let collectHealth: typeof import("./collector.js").collectGatewayHealthSnapshot;
let channelPlugin: typeof import("../../test-utils/channel-plugins.js").createChannelTestPluginBase;
const timeoutProbe = { timedOut: true, error: "health collection timed out after 7000ms" };
const blockedAccounts = ["default", "blocked-1", "blocked-2", "blocked-3", "blocked-4"];
let scope: AsyncWorkScope;
const cleanup: Array<() => void> = [];
let sessionPrepared = createDeferredCore();

function hold<T>(value: T) {
  const deferred = createDeferredCore<T>();
  cleanup.push(() => deferred.resolve(value));
  return deferred;
}

function installProbe(accountIds: string[], probe: Probe, id = "chat") {
  const started: string[] = [];
  const work = { started, active: 0, maxActive: 0 };
  const resolveAccount = (_: OpenClawConfig, key?: string | null) => ({
    accountId: key ?? "default",
  });
  const plugin: ChannelPlugin<DeadlineAccount> = {
    ...channelPlugin({ id, label: "Deadline Test" }),
    config: {
      listAccountIds: () => accountIds,
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: () => true,
      isConfigured: () => true,
    },
    status: {
      probeAccount: async ({ account }) => {
        work.started.push(account.accountId);
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

function collect(audience: "public" | "admin" = "admin") {
  sessionPrepared = createDeferredCore();
  return scope.track(() => collectHealth({ audience, probe: true }));
}

async function flushHealthPreparation(collecting: Promise<unknown>) {
  // Settle real session I/O and its yield before advancing the fake deadline.
  await awaitGateBeforeSettlement(sessionPrepared.promise, collecting, "Early health settlement");
  await vi.advanceTimersByTimeAsync(0);
  await flushImmediate();
}

beforeAll(async () => {
  // mock-isolation: Keep health collection on fixture config without loading live runtime config.
  vi.doMock("../../config/config.js", () => ({ getRuntimeConfig: () => testConfig }));
  vi.doMock("../../config/sessions/paths.js", () => ({
    resolveSessionStorePathCore: () => sessionStorePath,
  }));
  // mock-isolation: control worker-read completion independently of the health deadline clock.
  vi.doMock("../../config/sessions/session-entry-read-runtime.js", () => ({
    withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub(() => {
      const summary = readSummary();
      sessionPrepared.resolve();
      return summary;
    }),
  }));
  vi.doMock("../../channels/plugins/read-only.js", () => ({
    listReadOnlyChannelPluginsForConfig: () => healthPluginsForTest,
  }));
  const [health, channelTestUtils] = await Promise.all([
    import("./collector.js"),
    import("../../test-utils/channel-plugins.js"),
  ]);
  collectHealth = health.collectGatewayHealthSnapshot;
  channelPlugin = channelTestUtils.createChannelTestPluginBase;
});

beforeEach(async () => {
  scope = new AsyncWorkScope();
  sessionStorePath = path.join(tempDirs.make("health-deadline-"), "sessions.json");
  readSummary.mockReset();
  testConfig = {};
  healthPluginsForTest = [];
  await collectHealth({ audience: "admin", probe: false });
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

const publicFailure = {
  ok: false,
  error:
    "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
};
it.each([
  ["imessage", publicFailure],
  ["chat", timeoutProbe],
] as const)(
  "retains only safe public negatives through a slow %s summary",
  async (channelId, expected) => {
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
    const collecting = collect("public");
    await flushHealthPreparation(collecting);
    await enteredSummary.promise;
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await collecting;
    expect(result.channels[channelId]?.probe).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("/Users/synthetic");
  },
);

it("preserves healthy accounts at the deadline and retains unfinished probe work", async () => {
  vi.useFakeTimers();
  const slowProbe = hold<Record<string, unknown>>({ ok: true });
  const accountIds = ["default", "fast-1", "fast-2", "fast-3", "fast-4", "fast-5"];
  const { work } = installProbe(accountIds, ({ accountId }) =>
    accountId === "default" ? slowProbe.promise : Promise.resolve({ ok: true, accountId }),
  );
  const snapshotPromise = collect();
  await flushHealthPreparation(snapshotPromise);
  await vi.advanceTimersByTimeAsync(7_000);
  const snap = await snapshotPromise;
  const channel = snap.channels.chat;
  expect(channel?.probe).toEqual(timeoutProbe);
  for (const accountId of accountIds.slice(1)) {
    expect(channel?.accounts?.[accountId]?.probe).toMatchObject({ ok: true });
  }
  const drained = vi.fn();
  const draining = scope.drain().then(drained);
  await vi.advanceTimersByTimeAsync(0);
  expect(drained).not.toHaveBeenCalled();
  slowProbe.resolve({ ok: true });
  await draining;
  expect(work.active).toBe(0);
}, 1_000);

it.each([
  { name: "session preparation exhausts the deadline", elapsed: 7_000, step: 0 },
  { name: "the wall clock jumps forward", elapsed: 0, step: 60_000 },
  { name: "the wall clock jumps backward", elapsed: 0, step: -60_000 },
])(
  "keeps the aggregate monotonic budget when $name",
  async ({ elapsed, step }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    const slowProbe = hold<Record<string, unknown>>({ ok: true });
    const { work } = installProbe(["default"], () =>
      step < 0 ? slowProbe.promise : Promise.resolve({ ok: true }),
    );
    readSummary.mockImplementation(() => {
      vi.advanceTimersByTime(elapsed);
      // Date changes independently of the monotonic deadline.
      vi.setSystemTime(Date.now() + step);
      return emptySummary();
    });

    const snapshotPromise = collect();
    await (elapsed ? snapshotPromise : flushHealthPreparation(snapshotPromise));
    await vi.advanceTimersByTimeAsync(7_000);
    const snap = await snapshotPromise;
    slowProbe.resolve({ ok: true });
    const expected = step > 0 ? { ok: true } : timeoutProbe;
    expect(snap.channels.chat?.probe).toEqual(expected);
    expect(snap.channels.chat?.accounts?.default?.probe).toEqual(expected);
    expect(work.started).toEqual(elapsed ? [] : ["default"]);
  },
  1_000,
);

it("expires queued probes without releasing occupied permits across collections", async () => {
  vi.useFakeTimers();
  const accountIds = [...blockedAccounts, "queued-1", "queued-2"];
  const blocked = hold<Record<string, unknown>>({ ok: true });
  const { work } = installProbe(accountIds, () => blocked.promise);

  for (let collection = 0; collection < 2; collection++) {
    const pending = collect("public");
    await flushHealthPreparation(pending);
    expect(work.started).toEqual(blockedAccounts);
    await vi.advanceTimersByTimeAsync(7_000);
    const snapshot = await pending;
    expect(work.started).toEqual(blockedAccounts);
    expect(work).toMatchObject({ active: 5, maxActive: 5 });
    for (const accountId of accountIds) {
      expect(snapshot.channels.chat?.accounts?.[accountId]?.probe).toEqual(timeoutProbe);
    }
  }
  blocked.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(7_000);
  expect(work.active).toBe(0);
}, 1_000);
