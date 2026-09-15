import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import { observeUpdateCandidateIoProgress } from "./update-candidate-io.test-support.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function waitForFile(file: string): Promise<void> {
  const started = performance.now();
  while (!(await fs.stat(file).catch(() => undefined))) {
    if (performance.now() - started > 5_000) {
      throw new Error(`Worker did not reach ${path.basename(file)}`);
    }
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 10);
    });
  }
}

it.each([undefined, 600_000])(
  "honors the %s ms allowance during metadata inventory",
  async (timeoutMs) => {
    const root = tempDirs.make("openclaw-metadata-budget-");
    const file = path.join(root, "database.sqlite");
    const ready = path.join(root, "ready");
    const release = path.join(root, "release");
    const preload = path.join(root, "metadata-wait.cjs");
    await fs.writeFile(file, "database");
    await fs.writeFile(
      preload,
      `
    const fs = require("node:fs");
    const stat = fs.statSync;
    fs.statSync = function(file, ...args) {
      if (file === ${JSON.stringify(file)}) {
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        while (!fs.existsSync(${JSON.stringify(release)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return stat.call(this, file, ...args);
    };
  `,
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const operation = readUpdateStateDatabaseSizes([file], {
      nodeRunner: process.execPath,
      sourceEnv: { ...process.env, ...sqliteWorkerPreloadEnv(preload) },
      stagingRoot: root,
      timeoutMs,
      signal: controller.signal,
    }).then(
      (sizes) => ({ sizes }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForFile(ready);
      await vi.advanceTimersByTimeAsync(400_000);
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 20);
      });
      await fs.writeFile(release, "continue");
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      if (timeoutMs === undefined) {
        expect(await operation).toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining("inventory failed (timeout"),
          }),
        });
      } else {
        expect(await operation).toEqual({ sizes: [{ path: file, sizeBytes: 8n }] });
      }
    } finally {
      await fs.writeFile(release, "continue");
      controller.abort();
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      vi.useRealTimers();
      await operation;
    }
  },
);

it.each([
  { name: "slow startup", bytes: 4096, waits: [31_000], completes: true },
  { name: "large database", bytes: 2 * 1024 ** 3, waits: [800_000], completes: true },
  {
    name: "late-discovered database",
    bytes: 4096,
    discoveredBytes: 2 * 1024 ** 3,
    waits: [800_000],
    completes: true,
  },
  {
    name: "continuing copy progress",
    bytes: 4096,
    waits: [200_000, 200_000, 200_000],
    completes: true,
  },
  { name: "stalled worker", bytes: 4096, waits: [400_000], completes: false },
  { name: "caller allowance", bytes: 4096, waits: [400_000], completes: true, timeoutMs: 600_000 },
  { name: "configured cache", bytes: 4096, waits: [0], completes: true, configuredCache: true },
])(
  "budgets schema inspection for $name",
  async ({ bytes, discoveredBytes, waits, completes, configuredCache, timeoutMs }) => {
    const root = tempDirs.make("openclaw-state-budget-");
    const stateDir = path.join(root, "source");
    const database = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(database), { recursive: true });
    const file = await fs.open(database, "w");
    await file.truncate(bytes);
    await file.close();
    const worker = path.join(
      root,
      "dist",
      runtimeProcessEntrypoints.updateCandidateState.distWorkerPath,
    );
    const ready = path.join(root, "ready");
    const release = path.join(root, "release");
    const progress = path.join(root, "progress");
    const cache = path.join(root, "configured-cache");
    await fs.mkdir(cache);
    await fs.mkdir(path.dirname(worker), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.writeFile(
      worker,
      `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { setTimeout as sleep } from "node:timers/promises";
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const request = JSON.parse(input);
      if (request.mode === "discover") {
        process.stdout.write(JSON.stringify({
          files: [[${JSON.stringify(database)}, { spellings: [${JSON.stringify(database)}] }]],
          sharedVersion: { path: path.join(request.stateDir, "state", "openclaw.sqlite"), userVersion: null },
        }));
      } else {
      if (request.mode !== "versions") throw new Error("Unexpected worker operation");
      const scratch = process.env.XDG_CACHE_HOME || ${JSON.stringify(path.join(root, "scratch"))};
      await fs.mkdir(scratch, { recursive: true });
      const copy = path.join(scratch, "database.sqlite");
      await fs.writeFile(copy, "copy");
      if (${discoveredBytes ?? 0}) await fs.truncate(copy, ${discoveredBytes ?? 0});
      await fs.writeFile(${JSON.stringify(ready)}, scratch);
      let last = "";
      while (!(await fs.stat(${JSON.stringify(release)}).catch(() => undefined))) {
        const next = await fs.readFile(${JSON.stringify(progress)}, "utf8").catch(() => "");
        if (next && next !== last) {
          await fs.appendFile(copy, next);
          await fs.writeFile(${JSON.stringify(progress)} + "." + next, "written");
          last = next;
        }
        await sleep(10);
      }
      process.stdout.write(JSON.stringify([{ path: ${JSON.stringify(database)}, userVersion: 3 }]));
      }
    `,
    );

    const now = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    const waitForObservation = observeUpdateCandidateIoProgress();
    let failed = false;
    const result = readUpdateStateSchemaVersions({
      root,
      stateDir,
      config: {},
      timeoutMs,
      env: configuredCache ? { XDG_CACHE_HOME: cache } : {},
    }).then(
      (versions) => ({ versions }),
      (error: unknown) => {
        failed = true;
        return { error };
      },
    );
    try {
      await waitForFile(ready);
      if (configuredCache) {
        const actual = await fs.realpath(await fs.readFile(ready, "utf8"));
        const relative = path.relative(await fs.realpath(cache), actual);
        expect(path.isAbsolute(relative)).toBe(false);
        expect(relative.split(path.sep)[0]).not.toBe("..");
      }
      await waitForObservation(discoveredBytes ?? 4);
      for (const [index, milliseconds] of waits.entries()) {
        elapsed += milliseconds;
        if (failed) {
          break;
        }
        if (index < waits.length - 1) {
          await fs.writeFile(progress, String(index + 1));
          await waitForFile(`${progress}.${index + 1}`);
          await waitForObservation(4 + index + 1);
        }
      }
    } finally {
      await fs.writeFile(release, "done");
      // Join the real process and its pipes before the fixture owner removes files.
      await result;
    }
    if (completes) {
      expect(await result).toEqual({ versions: [{ path: database, userVersion: 3 }] });
    } else {
      expect(await result).toMatchObject({ error: expect.any(Error) });
    }
  },
);
