import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { PluginHostCleanupTimeoutError } from "../plugins/host-hook-cleanup-timeout.js";
import {
  PluginRuntimeApplicationError,
  projectPluginRuntimeFailure,
} from "../plugins/lifecycle.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareConfigReloadTest,
  createReloaderHarness,
  makeSnapshot,
  flushWatcherChange,
  flushReload,
  closeTestConfigReloaders,
} from "./config-reload.test-support.js";
import { PluginAdmittedWorkTimeoutError } from "./server-plugin-reload-cleanup.js";
import { createPluginReloadLifecycle } from "./server-plugin-reload-lifecycle.js";

type Ports = Parameters<ReturnType<typeof createPluginReloadLifecycle>["run"]>[0];
function fixture() {
  const order: string[] = [];
  const lifecycle = createPluginReloadLifecycle("original");
  // Ports expose a read-only view; cases that need no unavailable plugins clear this owner.
  const unavailablePluginIds = new Set(["missing"]);
  const ports: Ports = {
    previousReloadStatus: undefined,
    channels: {
      release: vi.fn(() => {
        order.push("channels");
      }),
    },
    recovery: {
      unavailablePluginIds,
      dispose: vi.fn(async () => {
        order.push("dispose");
      }),
    },
    finishReloadInputs: {
      changedPluginIds: new Set(["plugin"]),
      runtime: {
        kernel: {
          pluginRuntimeGeneration: {
            finishReload: vi.fn(() => {
              order.push("finish");
            }),
          },
        },
        pluginRuntime: {
          registry: createTestRegistry(),
        },
      },
      restartDrainSignal: new AbortController().signal,
      log: { error: vi.fn() },
    },
  };
  return { order, lifecycle, ports, unavailablePluginIds };
}

it("waits for recovery disposal before publishing exact health or returning", async ({
  signal,
}) => {
  const f = fixture();
  const entered = createDeferred();
  const release = createDeferred();
  f.ports.recovery.dispose = async () => {
    f.order.push("dispose");
    entered.resolve();
    await release.promise;
  };
  let settled = false;
  void f.lifecycle.replacementOperation.settled.then(() => {
    settled = true;
  });
  const result = f.lifecycle.run(f.ports, async (facts) => {
    facts.phase = "dispose";
    facts.committed = true;
    facts.releaseResourceHandoff = () => {
      f.order.push("resource");
    };
    return "receipt";
  });
  try {
    await withinTest(entered.promise, signal);
    expect(settled).toBe(false);
    expect(f.order).toEqual(["resource", "channels", "finish", "dispose"]);
  } finally {
    release.resolve();
  }
  await expect(result).resolves.toBe("receipt");
  await expect(f.lifecycle.replacementOperation.settled).resolves.toEqual({
    kind: "applied",
    committed: true,
    unavailablePluginIds: ["missing"],
  });
  await expect(f.lifecycle.run(f.ports, async () => "second")).rejects.toThrow("already ran");
  expect(
    f.ports.finishReloadInputs.runtime.kernel.pluginRuntimeGeneration.finishReload,
  ).toHaveBeenCalledOnce();
});

it.each(["resource", "channels", "finish"] as const)(
  "short circuits the %s failure but always disposes",
  async (where) => {
    const f = fixture();
    const failure = new Error(where);
    const fail = () => {
      f.order.push(where);
      throw failure;
    };
    if (where === "channels") {
      f.ports.channels.release = fail;
    }
    if (where === "finish") {
      f.ports.finishReloadInputs.runtime.kernel.pluginRuntimeGeneration.finishReload = fail;
    }
    const result = f.lifecycle.run(f.ports, async (facts) => {
      facts.phase = "dispose";
      facts.releaseResourceHandoff =
        where === "resource"
          ? fail
          : () => {
              f.order.push("resource");
            };
    });
    await expect(result).rejects.toBe(failure);
    expect(f.order).toEqual([
      ...["resource", "channels", "finish"].slice(
        0,
        ["resource", "channels", "finish"].indexOf(where) + 1,
      ),
      "dispose",
    ]);
    await expect(f.lifecycle.replacementOperation.settled).resolves.toMatchObject({
      kind: "failed",
    });
  },
);

it.each([false, true])(
  "preserves cleanup originals including undefined; prefix=%s",
  async (prefix) => {
    const f = fixture();
    const first = new Error("resource");
    f.ports.recovery.dispose = async () => {
      const rejected = createDeferred();
      rejected.reject(undefined);
      await rejected.promise;
    };
    const result = f.lifecycle.run(f.ports, async (facts) => {
      facts.phase = "dispose";
      if (prefix) {
        facts.releaseResourceHandoff = () => {
          throw first;
        };
      }
    });
    const failure = await result.then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    expect(failure.resolved).toBe(false);
    if (!failure.resolved) {
      if (prefix) {
        expect(failure.error).toBeInstanceOf(AggregateError);
        assert(failure.error instanceof AggregateError);
        expect(failure.error.errors).toEqual([first, undefined]);
      } else {
        expect(failure.error).toBeUndefined();
      }
    }
    await expect(f.lifecycle.replacementOperation.settled).resolves.toMatchObject({
      kind: "failed",
    });
  },
);

it.each(["typed", "raw", "undefined"] as const)(
  "preserves %s primary and ordered cleanup causes",
  async (kind) => {
    const primary =
      kind === "typed"
        ? new PluginRuntimeApplicationError(
            "drain",
            {
              operationId: "original",
              generation: 2,
              pluginIds: ["plugin"],
              phase: "drain",
              committed: false,
            },
            { cause: new Error("drain") },
          )
        : kind === "raw"
          ? new Error("recovery escape")
          : undefined;
    for (const cleanup of [false, true]) {
      const f = fixture();
      const secondary = new Error("dispose");
      if (cleanup) {
        f.ports.recovery.dispose = async () => {
          throw secondary;
        };
      }
      const failure = await f.lifecycle
        .run(f.ports, async (facts) => {
          facts.phase = "drain";
          facts.restored = true;
          const rejected = createDeferred<never>();
          rejected.reject(primary);
          return rejected.promise;
        })
        .then(
          () => {
            throw new Error("Expected rejection");
          },
          (error: unknown) => error,
        );
      if (!cleanup) {
        expect(failure).toBe(primary);
      } else if (primary instanceof PluginRuntimeApplicationError) {
        expect(failure).toBeInstanceOf(PluginRuntimeApplicationError);
        expect(projectPluginRuntimeFailure(failure).runtime).toEqual(primary.details);
        assert(
          failure instanceof PluginRuntimeApplicationError &&
            failure.cause instanceof AggregateError,
        );
        expect(failure.cause.errors).toEqual([primary, secondary]);
      } else {
        expect(failure).toBeInstanceOf(AggregateError);
        assert(failure instanceof AggregateError);
        expect(failure.errors).toEqual([primary, secondary]);
      }
      await expect(f.lifecycle.replacementOperation.settled).resolves.toMatchObject({
        kind: cleanup ? "failed" : "restored",
      });
    }
  },
);

it.for([false, true])(
  "real config owner retries only a clean drain failure (cleanup failed=%s)",
  async (cleanupFailed, context) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      prepareConfigReloadTest(context);
      vi.useFakeTimers();
      const instance = new PluginInstance("codex");
      const release = instance.retainWork();
      const idle = vi.spyOn(instance, "waitForIdle");
      const initialConfig = {
        plugins: { entries: { codex: { enabled: true, config: { sandbox: "read-only" } } } },
      };
      const config = {
        plugins: { entries: { codex: { enabled: true, config: { sandbox: "workspace-write" } } } },
      };
      const f = fixture();
      const primary = new PluginRuntimeApplicationError(
        "drain",
        {
          operationId: "original",
          generation: 2,
          pluginIds: ["codex"],
          phase: "drain",
          committed: false,
        },
        {
          cause: new PluginAdmittedWorkTimeoutError(
            new Set(["codex"]),
            [instance],
            new PluginHostCleanupTimeoutError("fixture drain"),
            60000,
          ),
        },
      );
      if (cleanupFailed) {
        f.ports.recovery.dispose = async () => {
          throw new Error("dispose failed");
        };
      }
      const error = await f.lifecycle
        .run(f.ports, async (facts) => {
          facts.phase = "drain";
          throw primary;
        })
        .then(
          () => {
            throw new Error("Expected drain refusal");
          },
          (failure: unknown) => failure,
        );
      assert(error instanceof PluginRuntimeApplicationError);
      const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
        initialConfig,
        onHotReload: async () => {
          if (instance.retainedWorkCount > 0) {
            throw error;
          }
          return {
            status: "applied",
            runtime: { operationId: "next", generation: 3, pluginIds: ["codex"] },
          };
        },
      });
      try {
        await harness.reloader.ready;
        await flushWatcherChange(harness);
        expect(harness.onHotReload).toHaveBeenCalledOnce();
        expect(idle).toHaveBeenCalledTimes(cleanupFailed ? 0 : 1);
        release();
        await flushReload(harness.reloader);
        expect(harness.onHotReload).toHaveBeenCalledTimes(cleanupFailed ? 1 : 2);
      } finally {
        await closeTestConfigReloaders();
        harness.watcher.restore();
        release();
        await instance.dispose();
        idle.mockRestore();
        vi.useRealTimers();
      }
    });
  },
);

it("fails private replay health when committed retirement rejects but finalizers succeed", async () => {
  const f = fixture();
  f.unavailablePluginIds.clear();
  const failure = new Error("committed registry retirement failed");
  await expect(
    f.lifecycle.run(f.ports, async (facts) => {
      facts.phase = "dispose";
      facts.committed = true;
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(f.order).toEqual(["channels", "finish", "dispose"]);
  expect(
    f.ports.finishReloadInputs.runtime.kernel.pluginRuntimeGeneration.finishReload,
  ).toHaveBeenCalledWith(
    undefined,
    "applied",
    f.ports.finishReloadInputs.changedPluginIds,
    f.ports.finishReloadInputs.runtime.pluginRuntime.registry,
    f.ports.recovery.unavailablePluginIds,
    f.ports.finishReloadInputs.log.error,
  );
  await expect(f.lifecycle.replacementOperation.settled).resolves.toEqual({
    kind: "failed",
    committed: true,
    unavailablePluginIds: [],
  });
});

it.each([false, true])(
  "keeps public restored but fails private health after late channel recovery error=%s",
  async (channelRecoveryFailed) => {
    const f = fixture();
    f.unavailablePluginIds.clear();
    const failure = new Error("replacement failed");
    await expect(
      f.lifecycle.run(f.ports, async (facts) => {
        facts.phase = "activate";
        facts.restored = true;
        facts.channelRecoveryErrors = channelRecoveryFailed
          ? [new Error("unchanged channel failed")]
          : [];
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(f.order).toEqual(["channels", "finish", "dispose"]);
    expect(
      vi.mocked(f.ports.finishReloadInputs.runtime.kernel.pluginRuntimeGeneration.finishReload).mock
        .calls[0]?.[1],
    ).toBe("restored");
    await expect(f.lifecycle.replacementOperation.settled).resolves.toEqual({
      kind: channelRecoveryFailed ? "failed" : "restored",
      committed: false,
      unavailablePluginIds: [],
    });
  },
);
