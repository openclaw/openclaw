import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createConfigResolutionFacts,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
  loadPinnedRuntimeConfigAsync,
  registerRuntimeConfigSnapshotPreparer,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

describe("prepared runtime snapshots", () => {
  const unregister: Array<() => void> = [];

  afterEach(() => {
    unregister.splice(0).forEach((release) => release());
    resetConfigRuntimeState();
  });

  it("keeps registration and setters synchronous when an async companion is available", () => {
    const active: OpenClawConfig = { gateway: { port: 18789 } };
    setRuntimeConfigSnapshot(active);
    const prepare = vi.fn();
    const prepareAsync = vi.fn(async () => () => {});
    unregister.push(registerRuntimeConfigSnapshotPreparer(prepare, { prepareAsync }));
    expect(prepare).toHaveBeenCalledExactlyOnceWith(active);
    const next: OpenClawConfig = { gateway: { port: 19001 } };
    expect(setRuntimeConfigSnapshot(next)).toBeUndefined();
    expect(prepare).toHaveBeenLastCalledWith(next);
    expect(getRuntimeConfigSnapshot()).toBe(next);
    expect(prepareAsync).not.toHaveBeenCalled();
  });

  it("publishes a cold config only after its contributions and legacy callbacks are ready", async () => {
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const facts = createConfigResolutionFacts([]);
    setConfigResolutionFacts(candidate, facts);
    const started = createDeferredCore();
    const deferred = createDeferredCore<() => void>();
    const syncPrepare = vi.fn();
    const contribute = vi.fn(() => {
      expect(getRuntimeConfigSnapshot()).toBeNull();
      expect(getConfigResolutionFacts(candidate)).toBe(facts);
    });
    const legacyPrepare = vi.fn();
    unregister.push(
      registerRuntimeConfigSnapshotPreparer(syncPrepare, {
        prepareAsync: () => {
          started.resolve();
          return deferred.promise;
        },
      }),
      registerRuntimeConfigSnapshotPreparer(legacyPrepare),
    );
    const pending = loadPinnedRuntimeConfigAsync(async () => ({ config: candidate }));
    await started.promise;
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()).toBeNull();
    expect(contribute).not.toHaveBeenCalled();
    expect(legacyPrepare).not.toHaveBeenCalled();
    deferred.resolve(contribute);
    expect(await pending).toBe(candidate);
    expect(getRuntimeConfigSnapshot()).toBe(candidate);
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(1);
    expect(syncPrepare).not.toHaveBeenCalled();
    expect(legacyPrepare).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(contribute).toHaveBeenCalledOnce();
  });

  it.each([
    "publication",
    "reset without active snapshot",
    "registration",
    "unregistration",
    "candidate bytes",
    "candidate facts",
  ])("discards a cold candidate after %s changes during preparation", async (change) => {
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const started = createDeferredCore();
    const deferred = createDeferredCore<() => void>();
    const contribute = vi.fn();
    const release = registerRuntimeConfigSnapshotPreparer(() => {}, {
      prepareAsync: () => {
        started.resolve();
        return deferred.promise;
      },
    });
    unregister.push(release);
    const pending = loadPinnedRuntimeConfigAsync(async () => ({ config: candidate }));
    await started.promise;
    switch (change) {
      case "publication":
        setRuntimeConfigSnapshot({ gateway: { port: 20000 } });
        break;
      case "reset without active snapshot":
        resetConfigRuntimeState();
        break;
      case "registration":
        unregister.push(registerRuntimeConfigSnapshotPreparer(() => {}));
        break;
      case "unregistration":
        release();
        break;
      case "candidate bytes":
        candidate.gateway = { port: 20000 };
        break;
      case "candidate facts":
        setConfigResolutionFacts(candidate, createConfigResolutionFacts([]));
        break;
    }
    const active = getRuntimeConfigSnapshot();
    const metadata = getRuntimeConfigSnapshotMetadata();
    const result = active
      ? expect(pending).resolves.toBe(active)
      : expect(pending).rejects.toThrow("superseded");
    deferred.resolve(contribute);
    await result;
    expect(contribute).not.toHaveBeenCalled();
    expect(getRuntimeConfigSnapshot()).toBe(active);
    expect(getRuntimeConfigSnapshotMetadata()).toBe(metadata);
  });

  it("rolls back staged environment publication when its facts change during preparation", async () => {
    const env = { OPENCLAW_STATE_DIR: "/fixture/prepared-state" };
    const started = createDeferredCore();
    const gate = createDeferredCore<() => void>();
    const contribution = vi.fn();
    const rollback = Object.assign(vi.fn(), { commit: vi.fn() });
    unregister.push(
      registerRuntimeConfigSnapshotPreparer(() => {}, {
        prepareAsync: async (_config, context) => {
          expect(context.env).toBe(env);
          started.resolve();
          return gate.promise;
        },
      }),
    );
    const pending = loadPinnedRuntimeConfigAsync(async () => ({
      config: {},
      runtimeEnv: { env, publish: () => rollback },
    }));
    await started.promise;
    env.OPENCLAW_STATE_DIR = "/fixture/replaced-state";
    const rejected = expect(pending).rejects.toThrow("superseded");
    gate.resolve(contribution);
    await rejected;
    expect(rollback).toHaveBeenCalledOnce();
    expect(rollback.commit).not.toHaveBeenCalled();
    expect(contribution).not.toHaveBeenCalled();
    expect(getRuntimeConfigSnapshot()).toBeNull();
  });

  it("joins rejected preparation companions before failing the cold load", async () => {
    const deferred = createDeferredCore<() => void>();
    const remaining = createDeferredCore<() => void>();
    const started = createDeferredCore();
    const syncPrepare = vi.fn();
    const contribute = vi.fn();
    unregister.push(
      registerRuntimeConfigSnapshotPreparer(syncPrepare, {
        prepareAsync: () => {
          started.resolve();
          return deferred.promise;
        },
      }),
      registerRuntimeConfigSnapshotPreparer(() => {}, {
        prepareAsync: () => remaining.promise,
      }),
    );
    const pending = loadPinnedRuntimeConfigAsync(async () => ({
      config: { gateway: { port: 19001 } },
    }));
    const completed = vi.fn();
    const observed = pending.then(completed, completed);
    await started.promise;
    deferred.reject(new Error("preparation failed"));
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    remaining.resolve(contribute);
    await expect(pending).rejects.toThrow("preparation failed");
    await observed;
    expect(completed).toHaveBeenCalledOnce();
    expect(contribute).not.toHaveBeenCalled();
    expect(syncPrepare).not.toHaveBeenCalled();
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()).toBeNull();
  });
});

describe("async cold runtime pin", () => {
  const unregister: Array<() => void> = [];
  afterEach(() => {
    unregister.splice(0).forEach((release) => release());
    resetConfigRuntimeState();
  });

  it("reuses the active runtime without invoking a cold loader", async () => {
    const current: OpenClawConfig = { gateway: { port: 19001 } };
    setRuntimeConfigSnapshot(current);
    const load = vi.fn(async () => ({ config: {} }));
    expect(await loadPinnedRuntimeConfigAsync(load)).toBe(current);
    expect(load).not.toHaveBeenCalled();
  });

  it.each(
    (["resolves", "rejects"] as const).flatMap((completion) =>
      (["unchanged", "replacement"] as const).map((change) => ({ completion, change })),
    ),
  )(
    "retains selected runtime authority when a cold load $completion and publication is $change",
    async ({ completion, change }) => {
      const selected: OpenClawConfig = { gateway: { port: 18789 } };
      const replacement: OpenClawConfig = { gateway: { port: 19001 } };
      const failure = new Error("ordinary config read failure");
      let assertSelectedCurrent: (() => void) | undefined;
      const pending = loadPinnedRuntimeConfigAsync(
        async () => {
          if (completion === "rejects") {
            throw failure;
          }
          return { config: selected };
        },
        { retainSnapshotCurrent: (assertCurrent) => (assertSelectedCurrent = assertCurrent) },
      );
      const replace = () => {
        if (change === "replacement") {
          setRuntimeConfigSnapshot(replacement);
        }
      };
      // Register before the consumer so replacement wins the post-settlement microtask.
      const replacementDone = pending.then(replace, replace);
      if (completion === "resolves") {
        expect(await pending).toBe(selected);
      } else {
        await expect(pending).rejects.toBe(failure);
      }
      await replacementDone;
      expect(assertSelectedCurrent).toBeTypeOf("function");
      if (change === "replacement") {
        expect(assertSelectedCurrent).toThrow("superseded");
      } else {
        expect(assertSelectedCurrent).not.toThrow();
      }
    },
  );

  it("does not bless a cleared owner when a pending cold load rejects", async () => {
    const gate = createDeferredCore<{ config: OpenClawConfig }>();
    let assertSelectedCurrent: (() => void) | undefined;
    const pending = loadPinnedRuntimeConfigAsync(() => gate.promise, {
      retainSnapshotCurrent: (assertCurrent) => (assertSelectedCurrent = assertCurrent),
    });
    resetConfigRuntimeState();
    const failure = new Error("ordinary config read failure");
    const rejected = expect(pending).rejects.toBe(failure);
    gate.reject(failure);
    await rejected;

    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(assertSelectedCurrent).toThrow("superseded");
  });

  it.each(["reset", "newer publication"])("discards a cold load after %s", async (change) => {
    const gate = createDeferredCore<{ config: OpenClawConfig }>();
    let assertSelectedCurrent: (() => void) | undefined;
    const pending = loadPinnedRuntimeConfigAsync(() => gate.promise, {
      retainSnapshotCurrent: (assertCurrent) => (assertSelectedCurrent = assertCurrent),
    });
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const current: OpenClawConfig = { gateway: { port: 20001 } };
    if (change === "reset") {
      resetConfigRuntimeState();
      const rejected = expect(pending).rejects.toThrow("superseded");
      gate.resolve({ config: candidate });
      await rejected;
      expect(getRuntimeConfigSnapshot()).toBeNull();
      expect(assertSelectedCurrent).toThrow("superseded");
    } else {
      setRuntimeConfigSnapshot(current);
      gate.resolve({ config: candidate });
      expect(await pending).toBe(current);
      expect(getRuntimeConfigSnapshot()).toBe(current);
      expect(assertSelectedCurrent).not.toThrow();
    }
  });

  it("includes a preparer registered during loading without invalidating the load", async () => {
    const gate = createDeferredCore<{ config: OpenClawConfig }>();
    const pending = loadPinnedRuntimeConfigAsync(() => gate.promise);
    const sync = vi.fn();
    const contribution = vi.fn();
    const prepareAsync = vi.fn(async () => contribution);
    unregister.push(registerRuntimeConfigSnapshotPreparer(sync, { prepareAsync }));
    const config: OpenClawConfig = { gateway: { port: 19001 } };
    gate.resolve({ config });
    expect(await pending).toBe(config);
    expect(prepareAsync).toHaveBeenCalledExactlyOnceWith(config, { env: undefined });
    expect(contribution).toHaveBeenCalledOnce();
    expect(sync).not.toHaveBeenCalled();
  });

  it("rechecks caller authority after preparation without publishing environment or config", async () => {
    const started = createDeferredCore();
    const gate = createDeferredCore<() => void>();
    const contribution = vi.fn();
    unregister.push(
      registerRuntimeConfigSnapshotPreparer(() => {}, {
        prepareAsync: () => {
          started.resolve();
          return gate.promise;
        },
      }),
    );
    let current = true;
    const publish = vi.fn();
    const pending = loadPinnedRuntimeConfigAsync(
      async () => ({
        config: { gateway: { port: 19001 } },
        runtimeEnv: { env: {}, publish },
      }),
      {
        assertCurrent: () => {
          if (!current) {
            throw new Error("caller superseded");
          }
        },
      },
    );
    await started.promise;
    current = false;
    const rejected = expect(pending).rejects.toThrow("caller superseded");
    gate.resolve(contribution);
    await rejected;
    expect(publish).not.toHaveBeenCalled();
    expect(contribution).not.toHaveBeenCalled();
    expect(getRuntimeConfigSnapshot()).toBeNull();
  });

  it.each(["publication", "reset", "admission"] as const)(
    "does not publish a cold candidate superseded by a contribution's %s",
    async (change) => {
      const candidate: OpenClawConfig = { gateway: { port: 19001 } };
      const newer: OpenClawConfig = { gateway: { port: 20001 } };
      let admitted = true;
      const rollback = Object.assign(vi.fn(), { commit: vi.fn() });
      unregister.push(
        registerRuntimeConfigSnapshotPreparer(() => {}, {
          prepareAsync: async () => () => {
            if (change === "publication") {
              setRuntimeConfigSnapshot(newer);
            } else if (change === "reset") {
              resetConfigRuntimeState();
            } else {
              admitted = false;
            }
          },
        }),
      );
      const pending = loadPinnedRuntimeConfigAsync(
        async () => ({ config: candidate, runtimeEnv: { env: {}, publish: () => rollback } }),
        {
          assertCurrent: () => {
            if (!admitted) {
              throw new Error("caller superseded during contribution");
            }
          },
        },
      );
      if (change === "publication") {
        expect(await pending).toBe(newer);
        expect(getRuntimeConfigSnapshot()).toBe(newer);
      } else {
        await expect(pending).rejects.toThrow("superseded");
        expect(getRuntimeConfigSnapshot()).toBeNull();
      }
      expect(rollback).toHaveBeenCalledOnce();
      expect(rollback.commit).not.toHaveBeenCalled();
    },
  );
});
