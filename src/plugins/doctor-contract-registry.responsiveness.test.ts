import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { installDoctorCaptureProbe } from "./doctor-capture-probe.test-support.js";
import { preparePluginDoctorContractModules } from "./doctor-contract-preparation.js";
import * as doctor from "./doctor-contract-registry.js";
import { createDoctorGenerationFixture } from "./doctor-generation.test-support.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { writeArtifacts } from "./public-surface.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDefaultRetainedNativeWorkerSource();
});

it.each(["success", "cancellation", "retirement", "authority", "failure"] as const)(
  "settles Doctor %s while admitted setup source capture is paused",
  async (mode) => {
    expect(isMainThread, "Doctor proof must exercise the application main-thread branch").toBe(
      true,
    );
    const state = dirs.make("doctor-responsive-state-");
    const rootDir = dirs.make("doctor-responsive-source-");
    const { input, inventory } = createDoctorGenerationFixture(rootDir, "responsive");
    const payloads = Array.from(
      { length: 128 },
      (_, i) => `payload-${String(i).padStart(4, "0")}.txt`,
    );
    const contents = payloads.map((_, i) => `synthetic file ${i}\n`.repeat(64));
    writeArtifacts(rootDir, {
      "package.json": { type: "module" },
      "asset.txt": "original resource",
      "doctor-contract-api.mjs": `import fs from "node:fs";
      import { createHash } from "node:crypto";
      let calls = 0;
      export const stateMigrations = [{ id: "repair", label: "repair",
        detectLegacyState() { return { preview: ["fixture"] }; },
        migrateLegacyState() {
          const asset = new URL("./asset.txt", import.meta.url);
          const resource = fs.readFileSync(asset, "utf8");
          const hash = createHash("sha256");
          for (const file of ${JSON.stringify(payloads)}) hash.update(fs.readFileSync(new URL(file, import.meta.url)));
          fs.writeFileSync(asset, "changed by callback");
          return { changes: [String(++calls), resource, hash.digest("hex"), import.meta.url], warnings: [] };
        }
      }];`,
    });
    for (let i = 0; i < payloads.length; i++) {
      fs.writeFileSync(path.join(rootDir, payloads[i]!), contents[i]!);
    }
    const declared = inventory({ stateMigrations: [{ id: "repair" }] });
    const identity = fs.statSync(path.join(rootDir, payloads[0]!), { bigint: true });
    const signal = new Int32Array(new SharedArrayBuffer(4 * 6));
    Atomics.store(signal, 1, -1);
    const probe = {
      signal,
      device: identity.dev,
      inode: identity.ino,
      ...(mode === "failure" ? { failure: "injected admitted Doctor read failure" } : {}),
    };
    const scope = new AsyncWorkScope();
    let current = true;
    let activeCache: ReturnType<typeof createPluginCache> | undefined;
    let retirement: Promise<unknown> | undefined;
    const restoreRead = installDoctorCaptureProbe(probe, true);
    const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    const create = nativeSource.create.bind(nativeSource);
    vi.spyOn(nativeSource, "create").mockImplementation((filename, options = {}, ...rest) =>
      create(
        new URL("./doctor-capture-probe.test-support.ts", import.meta.url),
        {
          ...options,
          workerData: {
            ...options.workerData,
            doctorCaptureProbe: probe,
            doctorCaptureWorkerUrl: String(filename),
          },
        },
        ...rest,
      ),
    );
    // This worker only prevents the known-bad synchronous baseline from deadlocking the test.
    // The host timer below must release the candidate before this watchdog does.
    const watchdog = new Worker(
      `const { workerData } = require("node:worker_threads");
    const signal = workerData;
    while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0, 1000);
    Atomics.wait(signal, 0, 1, 1500);
    if (Atomics.compareExchange(signal, 0, 1, 2) === 1) {
      Atomics.store(signal, 4, 1); Atomics.notify(signal, 0);
    }`,
      { eval: true, execArgv: [], workerData: signal },
    );
    const timer = setInterval(() => {
      Atomics.add(signal, 2, 1);
      if (Atomics.load(signal, 0) === 1 && Atomics.load(signal, 2) - Atomics.load(signal, 3) >= 3) {
        Atomics.store(signal, 5, Atomics.load(signal, 2) - Atomics.load(signal, 3));
        if (mode === "cancellation") {
          scope.beginClose(new Error("Doctor preparation cancelled"));
        }
        if (mode === "retirement") {
          retirement = retirePluginCache(activeCache!);
        }
        if (mode === "authority") {
          current = false;
        }
        Atomics.store(signal, 0, 2);
        Atomics.notify(signal, 0);
      }
    }, 5);
    const results: Array<{ changes: string[]; digest: string | undefined }> = [];
    try {
      await withArtifactPreservingStateReads(() =>
        withPluginSourceCaptureStorage({ stateDir: state, placement: "temporary" }, () =>
          withPluginGenerationSourceCustody(async () => {
            for (let phase = 0; phase < (mode === "success" ? 2 : 1); phase++) {
              await using cache = createPluginCache();
              activeCache = cache;
              await withPluginCache(cache, async () => {
                const preparing = scope.run(() =>
                  preparePluginDoctorContractModules({
                    inventory: declared,
                    assertCurrent() {
                      if (!current) {
                        throw new Error("Doctor preparation authority revoked");
                      }
                    },
                  }),
                );
                if (mode !== "success") {
                  await expect(preparing).rejects.toThrow(
                    mode === "authority" ? "Doctor preparation authority revoked" : undefined,
                  );
                  await retirement;
                  expect(cache.setupModules.size).toBe(0);
                  expect(cache.instances.size).toBe(0);
                  return;
                }
                await preparing;
                const entry = doctor.listPluginDoctorStateMigrationEntries({
                  inventory: declared,
                })[0]!;
                const result = await entry.migration.migrateLegacyState(input);
                results.push({
                  changes: result.changes,
                  digest: [...cache.setupModules.values()][0]!.sourceDigest,
                });
              });
            }
          }),
        ),
      );
    } finally {
      clearInterval(timer);
      Atomics.store(signal, 0, 2);
      Atomics.notify(signal, 0);
      restoreRead();
      await watchdog.terminate();
      await scope.drain();
    }
    const expectedHash = createHash("sha256").update(contents.join("")).digest("hex");
    console.log(
      "DOCTOR_CAPTURE_PROOF " +
        JSON.stringify({
          mode,
          isMainThread,
          sourceDigests: results.map(({ digest }) => digest),
          callbackResults: results.map(({ changes }) => changes.slice(0, 3)),
          pausedOnHost: Atomics.load(signal, 1) === 1,
          watchdogReleased: Atomics.load(signal, 4) === 1,
          progressTicksWhilePaused: Atomics.load(signal, 5),
        }),
    );
    if (mode === "success") {
      expect(results.map(({ changes }) => changes.slice(0, 3))).toEqual([
        ["1", "original resource", expectedHash],
        ["1", "original resource", expectedHash],
      ]);
      expect(results[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(results[0]!.digest).toBe(results[1]!.digest);
      expect(fileURLToPath(results[0]!.changes[3]!)).not.toBe(
        fileURLToPath(results[1]!.changes[3]!),
      );
    }
    expect(Atomics.load(signal, 5)).toBeGreaterThanOrEqual(3);
    expect(nativeSource.hasActiveWorkers).toBe(false);
    expect(Atomics.load(signal, 0)).toBe(2);
    expect(
      Atomics.load(signal, 4),
      "the independent host timer must release capture before the watchdog",
    ).toBe(0);
    expect(
      Atomics.load(signal, 1),
      "the admitted file operation must run away from the Doctor host",
    ).toBe(0);
  },
  120_000,
);
