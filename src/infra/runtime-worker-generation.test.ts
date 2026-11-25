import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  captureRuntimeWorkerSource,
  resolveRuntimeWorkerGenerationUrl,
  withRuntimeWorkerGeneration,
  type RuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import { resolveProcessRuntimeWorkerFile } from "./runtime-worker-process-generation.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function runGeneration(operation: (generation: RuntimeWorkerGeneration) => Promise<unknown>) {
  vi.useFakeTimers();
  const release = vi.fn(async () => {});
  const report = vi.fn(() => "/retained-runtime");
  const completed = vi.fn();
  const result = withRuntimeWorkerGeneration(
    async (bind) => {
      bind(() => new URL("file:///retained-runtime/worker.mjs"));
      const { runtimeGeneration } = captureRuntimeWorkerSource(new URL("file:///worker.mjs"));
      assert.ok(runtimeGeneration);
      return operation(runtimeGeneration);
    },
    release,
    report,
  );
  const outcome = result.then(
    (value) => {
      completed();
      return { value };
    },
    (error: unknown) => {
      completed();
      return { error };
    },
  );
  return { release, report, completed, outcome };
}

function expectPending(...callbacks: (() => unknown)[]) {
  for (const callback of callbacks) {
    expect(callback).not.toHaveBeenCalled();
  }
}

it.each([false, true])(
  "keeps native retirement joined after its warning and preserves the outcome (failed=%s)",
  async (failed) => {
    const accepted = createDeferred();
    const native = createDeferred();
    const failure = new Error("update failed");
    const close = vi.fn(() => native.promise);
    const settle = vi.fn(async () => {
      await accepted.promise;
      return close;
    });
    const { release, report, completed, outcome } = runGeneration(async (runtimeGeneration) => {
      runtimeGeneration.retain({}, settle);
      if (failed) {
        throw failure;
      }
      return "update complete";
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settle).toHaveBeenCalledOnce();
      expectPending(close, report, release, completed);

      accepted.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(expect.stringContaining("waiting for native retirement"));
      expectPending(release, completed);

      const signalCompleted = vi.fn();
      const signalDrain = waitForSignalExitBarriers().then(signalCompleted);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signalCompleted).not.toHaveBeenCalled();
      native.resolve();
      await signalDrain;
      expect(await outcome).toEqual(failed ? { error: failure } : { value: "update complete" });
      expect(release).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      accepted.resolve();
      native.resolve();
      await outcome;
    }
  },
);

it.each([false, true])(
  "joins successful siblings without releasing a failed settlement (operationFailed=%s)",
  async (operationFailed) => {
    const native = createDeferred();
    const settlementFailure = new Error("worker did not settle");
    const operationFailure = new Error("update failed");
    const close = vi.fn(() => native.promise);
    const { release, report, completed, outcome } = runGeneration(async (runtimeGeneration) => {
      runtimeGeneration.retain({}, async () => close);
      runtimeGeneration.retain({}, async () => {
        throw settlementFailure;
      });
      if (operationFailed) {
        throw operationFailure;
      }
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledOnce();
      expectPending(completed, release);
      native.resolve();
      const result = await outcome;
      assert.ok("error" in result);
      const { error } = result;
      expect(error).toMatchObject({
        errors: operationFailed
          ? [operationFailure, { errors: [settlementFailure] }]
          : [settlementFailure],
      });
      expect(report).toHaveBeenLastCalledWith(expect.stringContaining("workers did not settle"));
      expect(release).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      native.resolve();
      await outcome;
    }
  },
);

it("joins all native retirements and retains the command error when one fails", async () => {
  const native = createDeferred();
  const operationFailure = new Error("update failed");
  const { release, report, completed, outcome } = runGeneration(async (runtimeGeneration) => {
    runtimeGeneration.retain({}, async () => async () => {
      throw new Error("native retirement failed");
    });
    runtimeGeneration.retain({}, async () => () => native.promise);
    throw operationFailure;
  });
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).not.toHaveBeenCalled();
    native.resolve();
    const result = await outcome;
    assert.ok("error" in result);
    expect(result.error).toBe(operationFailure);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining("termination failed"));
    expect(release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    native.resolve();
    await outcome;
  }
});

it("keeps explicit, ambient, embedded, and unchanged URL ownership separate", async () => {
  const original = new URL("file:///worker.mjs");
  const ambient = new URL("file:///ambient/worker.mjs");
  const explicit = new URL("file:///explicit/worker.mjs");
  const embedded = new URL("file:///runtime/dist/embedded.worker.js");
  vi.stubGlobal(
    "__openclawStandaloneIsEmbeddedModule",
    (filename: string) => filename === "/runtime/dist/embedded.worker.js",
  );
  const generation: RuntimeWorkerGeneration = { resolve: () => explicit, retain() {} };
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind(() => ambient);
      expect(captureRuntimeWorkerSource(original).moduleUrl).toBe(ambient);
      expect(resolveRuntimeWorkerGenerationUrl(original, generation)).toBe(explicit);
      expect(resolveRuntimeWorkerGenerationUrl(original, undefined)).toBe(original);
      expect(captureRuntimeWorkerSource(embedded)).toEqual({ moduleUrl: embedded });
      bind((url) => url);
      expect(captureRuntimeWorkerSource(original)).toEqual({ moduleUrl: original });
    },
    async () => {},
  );
});

it("starts a process owner's worker from the retained runtime after activation removed the package", async () =>
  withTestDir({ prefix: "retained-worker-" }, async (base) => {
    const installed = path.join(base, "installed", "dist", "probe.worker.mjs");
    const retained = path.join(base, "retained", "dist", "probe.worker.mjs");
    const writeProbe = async (file: string, label: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        `import { parentPort } from "node:worker_threads"; parentPort.postMessage(${JSON.stringify(label)});`,
      );
    };
    await writeProbe(installed, "installed");
    await writeProbe(retained, "retained");
    const installedUrl = pathToFileURL(installed);
    const reply = async (worker: Worker) => {
      const [message] = await once(worker, "message");
      await worker.terminate();
      return message;
    };
    // A process-wide owner created before the update (state lease heartbeat, file-log pool)
    // starts later workers from its own async context, outside the generation's scope.
    const owner = new AsyncResource("process-owner");
    const startFromOwner = () => owner.runInAsyncScope(() => createCpuTrackedWorker(installedUrl));

    const during = await withRuntimeWorkerGeneration(
      async (bind) => {
        bind((url) => (url.href === installedUrl.href ? pathToFileURL(retained) : url));
        // Activation replaced the installed package this process was loaded from.
        await fs.rm(path.join(base, "installed"), { recursive: true });
        return await reply(startFromOwner());
      },
      async () => {},
    );
    expect(during).toBe("retained");

    // Once the generation settles, the process no longer redirects its workers.
    await writeProbe(installed, "installed");
    expect(await reply(startFromOwner())).toBe("installed");
  }));

it("resolves a worker once when it was captured in scope and then spawned", async () => {
  const resolve = vi.fn((url: URL) => new URL(`${url.href}.retained.mjs`));
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind(resolve);
      const { moduleUrl } = captureRuntimeWorkerSource(new URL("file:///installed/worker.mjs"));
      // The spawn-time process resolver sees the captured URL and leaves it final.
      expect(resolveProcessRuntimeWorkerFile(moduleUrl)).toBe(moduleUrl);
      expect(String(resolveProcessRuntimeWorkerFile("/installed/other.mjs"))).toBe(
        "/installed/other.mjs.retained.mjs",
      );
    },
    async () => {},
  );
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolveProcessRuntimeWorkerFile("/installed/other.mjs")).toBe("/installed/other.mjs");
});
