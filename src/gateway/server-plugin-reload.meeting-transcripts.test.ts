import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/io.js";
import { resolveLocalMeetingBrowserRequest } from "../meeting-bot/browser-request.js";
import type { MeetingBrowserRequestCaller } from "../meeting-bot/platform-adapter-contract.js";
import type { MeetingSessionRecord } from "../meeting-bot/session-types.js";
import type { MeetingDurableTranscriptBridge } from "../meeting-bot/transcripts-bridge.js";
import { createMeetingDurableTranscriptBridge } from "../meeting-bot/transcripts-bridge.runtime.js";
import { PluginInstanceDrainTimeoutError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getPluginRegistryRuntime } from "../plugins/registry-runtime-binding.js";
import { clearActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearTranscriptCapturesForTest } from "../transcripts/capture.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { createPluginReloadRecoveryFixture } from "./server-plugin-reload.recovery.test-support.js";
import {
  dispatchTrustedPluginGatewayMethod,
  hasInProcessGatewayContext,
} from "./server-plugins.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const cleanups: Array<() => Promise<void>> = [];
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const realTimers = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };

beforeEach(async () => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  state = await createOpenClawTestState({ scenario: "minimal", label: "meeting-reload" });
});

afterEach(async () => {
  Object.assign(globalThis, realTimers);
  vi.useRealTimers();
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    await clearTranscriptCapturesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
    clearPluginMetadataLifecycleCaches();
    await state.cleanup();
  }
});

const session: MeetingSessionRecord<"chrome", "agent"> = {
  id: "meeting-1",
  url: "https://meeting.example/room",
  transport: "chrome",
  mode: "agent",
  agentId: "main",
  state: "active",
  createdAt: "2026-07-23T12:00:00.000Z",
  updatedAt: "2026-07-23T12:00:00.000Z",
  participantIdentity: "OpenClaw browser guest",
  realtime: { enabled: true, toolPolicy: "safe-read-only" },
  notes: [],
};

type BrowserEffect = {
  generation: number;
  label: string;
  owner?: string;
  scopes?: string[];
  actor?: unknown;
};
type CaptureHold = { label: string; entered: () => void; release: Promise<void> };

/** Fake the capture clock while keeping Node's timer async-context propagation. */
function useCaptureClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const fake = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };
  Object.assign(globalThis, {
    setInterval: (run: () => void, ms?: number) =>
      fake.setInterval(AsyncLocalStorage.bind(run), ms),
    setTimeout: (run: () => void, ms?: number) => fake.setTimeout(AsyncLocalStorage.bind(run), ms),
  });
}

async function createMeetingReloadFixture() {
  // Final effect: the Gateway's browser.request method, reached only through the
  // real in-process dispatch owners.
  const effects: BrowserEffect[] = [];
  // Dispatch loads modules through real I/O, so waits key off produced events
  // (browser calls, capture logs, quiesce), never a count of event-loop turns.
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of waiters) {
      waiter();
    }
  };
  const until = (done: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (done()) {
          waiters.delete(check);
          resolve();
        }
      };
      waiters.add(check);
      check();
    });
  const browserRequest = vi.fn(({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const body = params.body as { generation: number; label: string };
    effects.push({
      generation: body.generation,
      label: body.label,
      owner: client?.internal?.pluginRuntimeOwnerId,
      scopes: client?.connect.scopes,
      actor: client?.internal?.operatorRoleActor ?? client?.authenticatedUserProfile,
    });
    respond(true, { ok: true });
    notify();
  });
  const context = createContext([["browser.request", "operator.admin", "browser", browserRequest]]);
  const resolveGateway = () => context;
  const debug = vi.fn((_message: string) => notify());
  const generations: Array<{
    api: OpenClawPluginApi;
    bridge: MeetingDurableTranscriptBridge;
    callBrowser?: MeetingBrowserRequestCaller;
  }> = [];
  const holds: CaptureHold[] = [];
  // Captures that ran to completion. A tick that fires while the previous capture is
  // still settling is skipped by design, so tests advance the clock only after this.
  const finished: string[] = [];
  const fixture = await createPluginReloadRecoveryFixture(
    { cleanups, logMocks: log },
    {
      abortOnCandidateStart: false,
      register(api, owner, record) {
        if (owner !== "first") {
          return;
        }
        record.origin = "bundled";
        // Production loaders bind each generation's runtime to its Gateway
        // (createGatewayPluginRuntimeBindings); the shared reload fixture leaves it unbound.
        const registry = getPluginInstance(record)?.owner?.registry;
        const hostRuntime = registry && getPluginRegistryRuntime(registry);
        assert(hostRuntime);
        bindGatewayContextResolver(hostRuntime, resolveGateway);
        hostRuntime.gateway = {
          ...hostRuntime.gateway,
          isAvailable: async () => hasInProcessGatewayContext(resolveGateway),
          request: (method, params, requestOptions) =>
            dispatchTrustedPluginGatewayMethod(method, params, requestOptions, resolveGateway),
        };
        const generation = generations.length + 1;
        const bridge = createMeetingDurableTranscriptBridge({
          logger: { warn: vi.fn(), debug },
          options: {
            providerId: "meeting",
            providerName: "Meeting",
            stateDir: state.stateDir,
          },
        });
        const plugin: (typeof generations)[number] = { api, bridge };
        generations.push(plugin);
        api.registerService({
          id: "first-transcripts",
          start() {},
          // Mirrors reconcileTranscriptPolicy(false): stop capture with one final capture.
          stop: async () => {
            await bridge.stop(session, async () => {
              await plugin.callBrowser?.({
                method: "POST",
                path: "/act",
                body: { generation, label: "final" },
                timeoutMs: 1_000,
              });
            });
          },
        });
      },
    },
  );
  const join = async (generation: number) => {
    const plugin = generations[generation - 1];
    assert(plugin);
    const record = fixture.registryOwner.registry.plugins.find((entry) => entry.id === "first");
    const instance = record && getPluginInstance(record);
    assert(instance);
    let live = true;
    let periodic = 0;
    // Stand-in for the CLI join: an operator request whose plugin handler resolves
    // the browser caller and starts capture, then responds and disconnects.
    await withPluginRuntimeGatewayRequestScope(
      {
        client: createOperatorClient({ profileName: "meeting-joiner", scopes: ["operator.admin"] }),
        context,
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: () => live,
      },
      () =>
        instance.run(async () => {
          plugin.callBrowser = await resolveLocalMeetingBrowserRequest(plugin.api.runtime);
          const callBrowser = plugin.callBrowser;
          await plugin.bridge.start(session, async () => {
            const label = `capture ${++periodic}`;
            try {
              await callBrowser({
                method: "POST",
                path: "/act",
                body: { generation, label },
                timeoutMs: 1_000,
              });
              const hold = holds.find((candidate) => candidate.label === `${generation}:${label}`);
              if (hold) {
                hold.entered();
                await hold.release;
                // New browser work from a capture admitted before retirement.
                await callBrowser({
                  method: "POST",
                  path: "/act",
                  body: { generation, label: `${label} after hold` },
                  timeoutMs: 1_000,
                });
              }
            } finally {
              finished.push(`${generation}:${label}`);
              notify();
            }
          });
        }),
    );
    live = false;
  };
  const holdCapture = (label: string) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    holds.push({ label, entered: entered.resolve, release: release.promise });
    return { entered: entered.promise, release: release.resolve };
  };
  const labels = (generation?: number) =>
    effects
      .filter((effect) => generation === undefined || effect.generation === generation)
      .map((effect) => `${effect.generation}:${effect.label}`);
  return {
    fixture,
    effects,
    generations,
    debug,
    notify,
    until,
    finished: (generation: number, count: number) =>
      until(() => finished.filter((label) => label.startsWith(`${generation}:`)).length >= count),
    logged: (text: string, times = 1) =>
      until(() => debug.mock.calls.filter(([message]) => message.includes(text)).length >= times),
    join,
    holdCapture,
    labels,
    instance: (registry = fixture.registryOwner.registry) => {
      const record = registry.plugins.find((entry) => entry.id === "first");
      const instance = record && getPluginInstance(record);
      assert(instance);
      return instance;
    },
  };
}

it("keeps capturing under the plugin after the joining operator disconnects", async () => {
  const meeting = await createMeetingReloadFixture();
  useCaptureClock();
  await meeting.join(1);
  // Step one tick at a time: a tick still dispatching makes the next one skip.
  for (const tick of [1, 2]) {
    await vi.advanceTimersByTimeAsync(5_000);
    await meeting.finished(1, tick + 1);
  }

  expect(meeting.labels()).toEqual(["1:capture 1", "1:capture 2", "1:capture 3"]);
  expect(meeting.effects.every((effect) => effect.owner === "first")).toBe(true);
  // The immediate capture uses the operator; recurring capture belongs to the plugin.
  expect(meeting.effects.map((effect) => effect.actor)).toEqual([
    expect.objectContaining({ profileId: expect.any(String) }),
    { kind: "system" },
    { kind: "system" },
  ]);
  await meeting.generations[0]!.bridge.stop(session, async () => {});
});

it("drains an admitted capture through reload, refuses new ticks, and hands the meeting to the replacement", async () => {
  const meeting = await createMeetingReloadFixture();
  useCaptureClock();
  await meeting.join(1);
  const held = meeting.holdCapture("1:capture 2");
  await vi.advanceTimersByTimeAsync(5_000);
  await held.entered;
  expect(meeting.labels()).toEqual(["1:capture 1", "1:capture 2"]);

  // Another admitted call keeps reload in its drain after the capture finishes,
  // so a later timed tick arrives while the instance refuses new work.
  const otherCall = createDeferredCore();
  const old = meeting.instance();
  const otherWork = old.run(() => otherCall.promise);
  const oldApi = meeting.generations[0]!.api;
  const oldCallBrowser = meeting.generations[0]!.callBrowser!;
  const quiesce = old.quiesce.bind(old);
  vi.spyOn(old, "quiesce").mockImplementation(() => {
    const accepting = quiesce();
    meeting.notify();
    return accepting;
  });
  const reloading = meeting.fixture.reload();
  await meeting.until(() => !old.acceptingCalls);
  expect(meeting.fixture.registryOwner.registry).toBe(meeting.fixture.previousRegistry);

  // Admitted work may finish, including its new browser call after retirement began.
  held.release();
  await vi.advanceTimersByTimeAsync(0);
  await meeting.finished(1, 2);
  expect(meeting.labels()).toEqual(["1:capture 1", "1:capture 2", "1:capture 2 after hold"]);

  // A tick that would start new capture work is refused before browser.request.
  await vi.advanceTimersByTimeAsync(5_000);
  await meeting.logged("Plugin first was reloaded or disabled");
  expect(meeting.labels()).toHaveLength(3);

  otherCall.resolve();
  await otherWork;
  await vi.advanceTimersByTimeAsync(0);
  await expect(reloading).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
  // The service stop's final capture is admitted cleanup and reaches the browser.
  expect(meeting.labels(1)).toEqual([
    "1:capture 1",
    "1:capture 2",
    "1:capture 2 after hold",
    "1:final",
  ]);
  expect(meeting.fixture.registryOwner.registry).not.toBe(meeting.fixture.previousRegistry);

  // The replacement instance owns the meeting; the retired instance cannot reach it.
  await meeting.join(2);
  for (const tick of [1, 2]) {
    await vi.advanceTimersByTimeAsync(5_000);
    await meeting.finished(2, tick + 1);
  }
  expect(meeting.labels(2)).toEqual(["2:capture 1", "2:capture 2", "2:capture 3"]);
  await expect(
    oldCallBrowser({
      method: "POST",
      path: "/act",
      body: { generation: 1, label: "stale" },
      timeoutMs: 1_000,
    }),
  ).rejects.toThrow('Plugin "first" runtime is no longer active.');
  expect(() => oldApi.lifecycle.runInBackgroundContext!(() => "stale tick")).toThrow(
    "Plugin first was reloaded or disabled",
  );
  expect(meeting.labels(1)).toHaveLength(4);
  await meeting.generations[1]!.bridge.stop(session, async () => {});
});

it.each([
  { label: "before the drain limit", elapsedMs: 4_000, forced: false },
  { label: "after forced retirement", elapsedMs: 6_000, forced: true },
])(
  "refuses new browser work from an admitted capture once its instance retires ($label)",
  async ({ elapsedMs, forced }) => {
    const meeting = await createMeetingReloadFixture();
    useCaptureClock();
    await meeting.join(1);
    const held = meeting.holdCapture("1:capture 2");
    await vi.advanceTimersByTimeAsync(5_000);
    await held.entered;

    // Gateway shutdown and reload disposal both retire through PluginInstance.dispose().
    const instance = meeting.instance();
    const disposed = instance.dispose();
    await vi.advanceTimersByTimeAsync(elapsedMs);
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    // The resumed capture's browser call is refused, and reported, before dispatch.
    await meeting.logged('Plugin "first" runtime is no longer active.');

    expect(meeting.labels()).toEqual(["1:capture 1", "1:capture 2"]);
    // Before the limit, disposal completes once that capture settles; no clock advance.
    const result = await disposed;
    expect(result.errors.some((error) => error instanceof PluginInstanceDrainTimeoutError)).toBe(
      forced,
    );
    await meeting.generations[0]!.bridge.stop(session, async () => {});
  },
);
