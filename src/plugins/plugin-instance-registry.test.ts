import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  PluginInstanceDrainTimeoutError,
  PluginInstanceUnavailableError,
} from "./plugin-instance-error.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("ordinary non-joining registry calls", () => {
  it.each(["result", "nested callback"] as const)(
    "revokes a late %s after forced retirement without granting cleanup admission",
    async (kind) => {
      vi.useFakeTimers();
      const instance = new PluginInstance("registry-call");
      const registry = createEmptyPluginRegistry();
      const release = createDeferredCore();
      const effect = vi.fn(() => "late effect");
      const callback = instance.wrap(effect);
      const pending = instance.runInRegistry(
        registry,
        async () => {
          await release.promise;
          return kind === "result" ? "late result" : callback();
        },
        { joinDisposal: false },
      );
      void pending.catch(() => {});
      const retirement = instance.dispose();
      let settlement: Promise<void> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        const timeout = (await retirement).errors[0];
        expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
        if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
          throw new Error("Expected forced registry-call retirement");
        }
        settlement = timeout.settled;
        release.resolve();
        await expect(pending).rejects.toBeInstanceOf(PluginInstanceUnavailableError);
        expect(effect).not.toHaveBeenCalled();
        await settlement;
      } finally {
        release.resolve();
        await Promise.allSettled([pending, retirement, settlement]);
        vi.useRealTimers();
      }
    },
  );

  it("runs the cleanup owner before draining the background work it stops", async () => {
    const instance = new PluginInstance("background-owner");
    const stop = createDeferredCore();
    const work = instance.lifecycle.runInBackgroundContext(async () => {
      await stop.promise;
      return "stopped";
    });
    instance.lifecycle.onDispose(async () => {
      stop.resolve();
      expect(await work).toBe("stopped");
    });

    // The drain deadline would report forced retirement instead.
    await expect(instance.dispose()).resolves.toEqual({ errors: [] });
  });

  it("still drains joining calls before cleanup starts", async () => {
    const instance = new PluginInstance("joining-call");
    const release = createDeferredCore();
    const events: string[] = [];
    const call = instance.run(async () => {
      await release.promise;
      events.push("call");
    });
    instance.lifecycle.onDispose(() => {
      events.push("cleanup");
    });
    const retirement = instance.dispose();
    await setImmediate();
    expect(events).toEqual([]);
    release.resolve();

    await expect(retirement).resolves.toEqual({ errors: [] });
    await call;
    expect(events).toEqual(["call", "cleanup"]);
  });
});
