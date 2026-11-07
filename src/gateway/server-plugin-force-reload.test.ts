import { expect, it, vi } from "vitest";
import type {
  CapturedPluginMaintenanceContinuation,
  PluginMaintenanceOutcome,
} from "../agents/plugin-maintenance-continuation.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginForceReload } from "./server-plugin-force-reload.js";

function continuation(settled = Promise.resolve()) {
  return {
    owner: {},
    interrupt: vi.fn(async () => {}),
    settled,
    finish: vi.fn(async () => {}),
    cancel: vi.fn(),
  } satisfies CapturedPluginMaintenanceContinuation;
}

it("captures reconciled exact owners before interruption and waits for physical settlement", async () => {
  const selected = new PluginInstance("selected");
  const unrelated = new PluginInstance("unrelated");
  const first = {},
    second = {},
    other = {};
  const releaseFirst = selected.retainWork("prepared-generation-lease", first);
  const releaseOther = unrelated.retainWork("prepared-generation-lease", other);
  let releaseSecond: (() => void) | undefined;
  const physical = createDeferredCore();
  const interrupted = createDeferredCore();
  const a = continuation(physical.promise),
    b = continuation(physical.promise);
  const capture = vi.fn((owner: object) => {
    if (owner === first) {
      releaseSecond = selected.retainWork("prepared-generation-lease", second);
      return Promise.resolve(a);
    }
    return owner === second ? Promise.resolve(b) : undefined;
  });
  b.interrupt = vi.fn(async () => interrupted.resolve());
  const coordinator = createPluginForceReload(() => {}, capture);
  let drained = false;
  const draining = coordinator.drain([selected], new AbortController().signal).then(() => {
    drained = true;
  });
  await interrupted.promise;
  expect(capture.mock.calls.map(([owner]) => owner)).toEqual([first, second]);
  expect(drained).toBe(false);
  expect(selected.retainedWorkCount).toBe(2);
  expect(unrelated.retainedWorkCount).toBe(1);
  releaseFirst();
  releaseSecond?.();
  physical.resolve();
  await draining;
  const outcome: PluginMaintenanceOutcome = { ok: true, pluginIds: ["selected"] };
  await coordinator.finish(outcome, true);
  await coordinator.finish(outcome, true);
  expect(a.finish).toHaveBeenCalledExactlyOnceWith(outcome, true, expect.any(Function));
  expect(b.finish).toHaveBeenCalledExactlyOnceWith(outcome, true, expect.any(Function));
  expect(unrelated.retainedWorkCount).toBe(1);
  releaseOther();
});

it("rejects unsupported work before interrupting any captured owner", async () => {
  const instance = new PluginInstance("selected");
  const supported = {},
    unsupported = {};
  const release = [
    instance.retainWork("unknown", supported),
    instance.retainWork("unknown", unsupported),
  ];
  const captured = continuation();
  const coordinator = createPluginForceReload(
    () => {},
    (owner) => (owner === supported ? Promise.resolve(captured) : undefined),
  );
  await expect(coordinator.drain([instance], new AbortController().signal)).rejects.toThrow(
    "no supported native conversation continuation",
  );
  expect(captured.interrupt).not.toHaveBeenCalled();
  expect(captured.cancel).toHaveBeenCalledOnce();
  expect(instance.retainedWorkCount).toBe(2);
  release.forEach((done) => done());
});

it("does not force or wake a cooperative owner whose actual lease already released", async () => {
  const instance = new PluginInstance("selected"),
    owner = {};
  const release = instance.retainWork("prepared-generation-lease", owner);
  const captured = continuation();
  const coordinator = createPluginForceReload(
    () => {},
    async () => {
      release();
      return captured;
    },
  );
  await coordinator.drain([instance], new AbortController().signal);
  await coordinator.finish({ ok: true, pluginIds: ["selected"] }, true);
  expect(captured.interrupt).not.toHaveBeenCalled();
  expect(captured.finish).not.toHaveBeenCalled();
  expect(captured.cancel).toHaveBeenCalledOnce();
});

it.each(["capture", "grace"] as const)(
  "does not interrupt owners when maintenance authority is revoked during %s",
  async (phase) => {
    vi.useFakeTimers();
    const instance = new PluginInstance("selected");
    const owner = {};
    const release = instance.retainWork("prepared-generation-lease", owner);
    const captured = continuation();
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("maintenance authority revoked");
      }
    };
    const capture = vi.fn(async () => {
      if (phase === "capture") {
        current = false;
      } else {
        setTimeout(() => {
          current = false;
        }, 10);
      }
      return captured;
    });
    const coordinator = createPluginForceReload(assertCurrent, capture);
    try {
      const result = coordinator
        .drain([instance], new AbortController().signal)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(251);
      expect(await result).toMatchObject({ message: "maintenance authority revoked" });
      expect(captured.interrupt).not.toHaveBeenCalled();
      expect(captured.cancel).toHaveBeenCalledOnce();
    } finally {
      release();
      vi.useRealTimers();
    }
  },
);
