import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { currentUpdateCheckLifecycle } from "../infra/update-check-lifecycle.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDeferredGatewayUpdateCheck } from "./server-startup-update-check.js";

type UpdateCheckStartupParams = Parameters<typeof createDeferredGatewayUpdateCheck>[0];
type UpdateCheck = Awaited<ReturnType<UpdateCheckStartupParams["createUpdateCheck"]>>;
type UpdateCheckParams = Parameters<UpdateCheckStartupParams["createUpdateCheck"]>[0];

describe("deferred Gateway update-check lifecycle", () => {
  let state: OpenClawTestState;
  let defaultUpdateCheck: UpdateCheck;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  const owners = new Set<ReturnType<typeof createDeferredGatewayUpdateCheck>>();

  beforeEach(async () => {
    resetGatewayWorkAdmission();
    scheduler = createTestGatewayScheduler();
    state = await createOpenClawTestState({ label: "gateway-update-check" });
    defaultUpdateCheck = {
      initialize: vi.fn(async () => ({
        root: null,
        status: { root: null, installKind: "unknown" as const, packageManager: "unknown" as const },
        installReceipt: null,
      })),
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    };
  });

  afterEach(async () => {
    try {
      await Promise.all([...owners].map((owner) => owner.stop()));
      await scheduler.stop();
    } finally {
      owners.clear();
      resetGatewayWorkAdmission();
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
      vi.restoreAllMocks();
    }
  });

  async function startUpdateCheck(overrides: Partial<UpdateCheckStartupParams> = {}, start = true) {
    const owner = createDeferredGatewayUpdateCheck({
      scheduler,
      createUpdateCheck: () => defaultUpdateCheck,
      getConfig: () => ({}),
      log: { info: vi.fn(), warn: vi.fn() },
      isNixMode: false,
      broadcastToConnIds: vi.fn(),
      getClientConnIds: () => new Set(),
      ...overrides,
    });
    owners.add(owner);
    if (start) {
      owner.start();
    }
    return owner;
  }

  async function waitForGatewayTestState(assertion: () => void | Promise<void>) {
    await vi.waitFor(assertion, { interval: 1 });
  }

  function mockCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error("expected update-check factory call");
    }
    return call[0];
  }

  it("owns RPC update work when autonomous checks never start", async () => {
    const createUpdateCheck = vi.fn(() => defaultUpdateCheck);
    const owner = await startUpdateCheck({ createUpdateCheck }, false);
    const lifecycle = currentUpdateCheckLifecycle();
    const entered = createDeferred();
    const cleanup = createDeferred();
    const cancelled = createDeferred();
    const work = lifecycle.run(async (signal) => {
      signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      entered.resolve();
      await cleanup.promise;
    });
    await entered.promise;

    expect(scheduler.nextWakeAtMs).toBeNull();
    let stopped = false;
    const stopping = owner.stop().then(() => {
      stopped = true;
    });
    try {
      await cancelled.promise;
      expect(stopped).toBe(false);
      expect(createUpdateCheck).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await Promise.all([work, stopping]);
    }
    expect(stopped).toBe(true);
    expect(scheduler.nextWakeAtMs).toBeNull();
  });

  it("scopes detailed update broadcasts to read-capable operator clients", async () => {
    const clients = [
      {
        connId: "pairing",
        connect: { role: "operator", scopes: ["operator.pairing"] },
      },
      { connId: "node", connect: { role: "node", scopes: ["node.read"] } },
      {
        connId: "operator-read",
        connect: { role: "operator", scopes: ["operator.read"] },
      },
    ];
    const broadcastToConnIds = vi.fn();
    const getClientConnIds: UpdateCheckStartupParams["getClientConnIds"] = (filter) =>
      new Set(
        clients
          .filter((client) => !filter || filter(client as never))
          .map((client) => client.connId),
      );
    const createGatewayUpdateCheck = vi.fn(() => defaultUpdateCheck);

    const result = await startUpdateCheck({
      broadcastToConnIds,
      getClientConnIds,
      createUpdateCheck: createGatewayUpdateCheck,
    });
    await waitForGatewayTestState(() => {
      expect(createGatewayUpdateCheck).toHaveBeenCalledTimes(1);
    });

    const updateCheckParams = mockCallArg(createGatewayUpdateCheck) as UpdateCheckParams;
    const updateAvailable = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev" as const,
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    };
    const schedule = {
      channel: "dev" as const,
      autoEnabled: true,
      install: { kind: "git" as const },
      target: {
        kind: "git" as const,
        currentSha: updateAvailable.currentSha,
        upstreamRef: updateAvailable.upstreamRef,
        upstreamSha: updateAvailable.upstreamSha,
        commitsBehind: updateAvailable.commitsBehind,
        commits: updateAvailable.commits,
      },
    };

    updateCheckParams.onUpdateAvailableChange?.(updateAvailable);
    updateCheckParams.onUpdateScheduleChange?.(schedule);

    expect(broadcastToConnIds.mock.calls).toEqual([
      ["update.available", { updateAvailable }, new Set(["operator-read"]), { dropIfSlow: true }],
      [
        "update.available",
        {
          updateAvailable: {
            currentVersion: updateAvailable.currentVersion,
            latestVersion: updateAvailable.latestVersion,
            channel: updateAvailable.channel,
          },
        },
        new Set(["pairing", "node"]),
        { dropIfSlow: true },
      ],
      [
        "update.available",
        { updateAvailable, schedule },
        new Set(["operator-read"]),
        { dropIfSlow: true },
      ],
      [
        "update.available",
        {
          updateAvailable: {
            currentVersion: updateAvailable.currentVersion,
            latestVersion: updateAvailable.latestVersion,
            channel: updateAvailable.channel,
          },
        },
        new Set(["pairing", "node"]),
        { dropIfSlow: true },
      ],
    ]);
    await result.stop();
    broadcastToConnIds.mockClear();
    updateCheckParams.onUpdateAvailableChange?.(updateAvailable);
    updateCheckParams.onUpdateScheduleChange?.(schedule);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("joins a late update-check factory and its cleanup when close wins startup", async () => {
    const factory = createDeferred<UpdateCheck>();
    const cleanup = createDeferred();
    const updateCheck = {
      initialize: vi.fn(defaultUpdateCheck.initialize),
      start: vi.fn(),
      stop: vi.fn(() => cleanup.promise),
    };
    const createGatewayUpdateCheck = vi.fn(() => factory.promise);

    const result = await startUpdateCheck({ createUpdateCheck: createGatewayUpdateCheck });

    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await waitForGatewayTestState(() => {
        expect(createGatewayUpdateCheck).toHaveBeenCalledTimes(1);
      });
      stopping = result.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(updateCheck.stop).not.toHaveBeenCalled();
      factory.resolve(updateCheck);
      await waitForGatewayTestState(() => expect(updateCheck.stop).toHaveBeenCalledOnce());
      expect(stopped).toBe(false);
      expect(updateCheck.initialize).not.toHaveBeenCalled();
      expect(updateCheck.start).not.toHaveBeenCalled();
    } finally {
      factory.resolve(updateCheck);
      cleanup.resolve();
      await (stopping ?? result.stop());
    }
    await result.stop();
    expect(updateCheck.stop).toHaveBeenCalledOnce();
  });

  it("joins update notices before releasing the update-check shutdown owner", async () => {
    const notices = createDeferred();
    const stopWatcher = vi.fn(() => notices.promise);
    const watcherModule = await import("./update-run-watcher.js");
    const startWatcher = vi
      .spyOn(watcherModule, "startUpdateRunWatcher")
      .mockReturnValue({ stop: stopWatcher });
    const result = await startUpdateCheck();
    let stopped = false;
    const stopping = result.stop().then(() => {
      stopped = true;
    });
    try {
      expect(stopWatcher).toHaveBeenCalledOnce();
      expect(defaultUpdateCheck.stop).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBe(false);
      notices.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      notices.resolve();
      await stopping;
      startWatcher.mockRestore();
    }
  });

  it("skips eager install discovery when startup update checks are disabled", async () => {
    const result = await startUpdateCheck({
      getConfig: () => ({ update: { checkOnStart: false } }),
    });
    await waitForGatewayTestState(() => {
      expect(defaultUpdateCheck.start).toHaveBeenCalled();
    });
    expect(defaultUpdateCheck.initialize).not.toHaveBeenCalled();
    await result.stop();
  });

  it("skips eager install discovery when auto-update is disabled by environment", async () => {
    process.env.OPENCLAW_NO_AUTO_UPDATE = "1";
    try {
      const result = await startUpdateCheck();
      await waitForGatewayTestState(() => {
        expect(defaultUpdateCheck.start).toHaveBeenCalled();
      });
      expect(defaultUpdateCheck.initialize).not.toHaveBeenCalled();
      await result.stop();
    } finally {
      delete process.env.OPENCLAW_NO_AUTO_UPDATE;
    }
  });

  it("fences update discovery immediately and joins its pending initialization", async () => {
    const initialization = createDeferred<Awaited<ReturnType<UpdateCheck["initialize"]>>>();
    const cleanup = createDeferred();
    const updateCheck = {
      initialize: vi.fn(() => initialization.promise),
      start: vi.fn(),
      stop: vi.fn(() => cleanup.promise),
    };
    const result = await startUpdateCheck({ createUpdateCheck: () => updateCheck });
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      expect(updateCheck.initialize).toHaveBeenCalledOnce();
      stopping = result.stop().then(() => {
        stopped = true;
      });
      expect(updateCheck.stop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBe(false);
      expect(updateCheck.start).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      initialization.resolve(await defaultUpdateCheck.initialize());
      await (stopping ?? result.stop());
    }
  });
});
