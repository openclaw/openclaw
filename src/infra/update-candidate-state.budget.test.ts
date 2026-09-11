import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.useRealTimers());

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
  { name: "configured cache", bytes: 4096, waits: [0], completes: true, configuredCache: true },
])(
  "budgets schema inspection for $name",
  async ({ bytes, discoveredBytes, waits, completes, configuredCache }) => {
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
      if (JSON.parse(input).mode !== "versions") throw new Error("Unexpected worker operation");
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
    `,
    );

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let failed = false;
    const result = readUpdateStateSchemaVersions({
      root,
      stateDir,
      config: {},
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
      await vi.advanceTimersByTimeAsync(2_000);
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 20);
      });
      for (const [index, milliseconds] of waits.entries()) {
        await vi.advanceTimersByTimeAsync(milliseconds);
        await new Promise<void>((resolve) => {
          realSetTimeout(resolve, 20);
        });
        if (failed) {
          break;
        }
        if (index < waits.length - 1) {
          await fs.writeFile(progress, String(index + 1));
          await waitForFile(`${progress}.${index + 1}`);
          await vi.advanceTimersByTimeAsync(1_000);
          await new Promise<void>((resolve) => {
            realSetTimeout(resolve, 20);
          });
        }
      }
    } finally {
      await fs.writeFile(release, "done");
      // Join the real process and its pipes before the fixture owner removes files.
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await result;
    }
    if (completes) {
      expect(await result).toEqual({ versions: [{ path: database, userVersion: 3 }] });
    } else {
      expect(await result).toMatchObject({ error: expect.any(Error) });
    }
  },
);
