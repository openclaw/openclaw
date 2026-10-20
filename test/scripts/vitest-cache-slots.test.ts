import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { createVitestCacheSlots } from "../../scripts/lib/vitest-cache-slots.mts";
import { applyDefaultVitestCachePaths } from "../../scripts/test-projects.test-support.mts";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { loadVitestPerformanceConfig } from "../vitest/vitest.performance-config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const spec = {
  config: "test/a.ts",
  env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/cache/original" },
  watchMode: false,
  cacheAssignment: { kind: "scheduler" as const, root: "/cache" },
};
const joined = { groupJoined: true };

function cacheFixture() {
  const lease = createVitestCacheSlots("linux");
  function hold<R extends { groupJoined: boolean }>(result: R, entry = spec) {
    const gate = createDeferred<R>();
    let assignedPath = "";
    const done = lease(entry, (assigned) => {
      assignedPath = assigned.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH;
      return gate.promise;
    });
    const finish = () => {
      gate.resolve(result);
      return done;
    };
    onTestFinished(async () => {
      await finish();
    });
    return { path: assignedPath, finish };
  }
  return {
    lease,
    hold,
    visit: async (entry = spec, groupJoined = true) => {
      const held = hold({ groupJoined }, entry);
      await held.finish();
      return held.path;
    },
  };
}

it.skipIf(process.platform === "win32")(
  "reuses separately warmed configs through the default root in serial, reordered, and parallel project runs",
  async () => {
    const root = tempDirs.make("vitest-cache-layout-");
    const env: NodeJS.ProcessEnv = {};
    const run = async (configs: string[], parallel: boolean, seed = false) => {
      const lease = createVitestCacheSlots("linux");
      const specs = applyDefaultVitestCachePaths(
        configs.map((config) => ({ config, env, watchMode: false })),
        { env, cwd: root },
      );
      const visit = (entry: (typeof specs)[number]) =>
        lease(entry, async (assigned) => {
          const cache = loadVitestPerformanceConfig(assigned.env, "linux", root);
          const directory = cache.fsModuleCachePath!;
          const file = path.join(directory, `${entry.config}.js`);
          if (seed) {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(file, entry.config);
          } else {
            expect(fs.readFileSync(file, "utf8")).toBe(entry.config);
          }
          return joined;
        });
      const batches = parallel ? [specs] : specs.map((entry) => [entry]);
      for (const batch of batches) {
        await Promise.all(batch.map(visit));
      }
    };
    await run(["first.config.ts"], false, true);
    await run(["second.config.ts"], false, true);
    await run(["second.config.ts", "first.config.ts"], false);
    await run(["first.config.ts", "first.config.ts"], false);
    await run(["first.config.ts", "second.config.ts"], true);
  },
);

it("preserves an explicit caller leaf alongside a shared root", async () => {
  const env = {
    OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: "/shared-cache",
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/caller-owned-leaf",
  };
  const assigned = applyDefaultVitestCachePaths([{ ...spec, env, cacheAssignment: undefined }], {
    env,
  });
  const lease = createVitestCacheSlots("linux");
  await lease(assigned[0]!, async (entry) => {
    expect(entry.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBe("/caller-owned-leaf");
    return joined;
  });
});

it("reuses an idle config cache while another config occupies its former scheduler slot", async () => {
  const { hold, visit } = cacheFixture();
  const first = hold(joined, { ...spec, config: "a.config.ts" });
  const peer = hold(joined, { ...spec, config: "b.config.ts" });
  await first.finish();
  const third = hold(joined, { ...spec, config: "c.config.ts" });
  await peer.finish();
  const reused = await visit({ ...spec, config: "a.config.ts" });
  expect(reused).toBe(first.path);
  expect(reused).not.toBe(third.path);
  expect(new Set([first.path, peer.path, third.path]).size).toBe(3);
});

it.each([true, false])(
  "isolates alias leases and respects join state (%s)",
  async (groupJoined) => {
    const { hold, visit } = cacheFixture();
    const first = hold({ groupJoined });
    const alias = {
      ...spec,
      config: groupJoined ? "test/x/../a.ts" : spec.config,
      // Different spellings may name the same physical root.
      cacheAssignment: {
        ...spec.cacheAssignment,
        root: groupJoined ? "/cache/x/.." : "/alias",
      },
    };
    const secondPath = await visit(alias, groupJoined);
    expect(secondPath).not.toBe(first.path);
    await first.finish();
    const thirdPath = await visit(groupJoined ? alias : spec);
    if (groupJoined) {
      expect(thirdPath).toBe(first.path);
    } else {
      expect(
        new Set([first.path, secondPath, thirdPath].map((value) => path.basename(value))).size,
      ).toBe(3);
    }
  },
);

it("holds concurrent leases until joined and reuses a failed command's completed slot", async () => {
  const { hold, visit } = cacheFixture();
  const first = hold({ groupJoined: true, code: 1 });
  const second = hold({ groupJoined: true, code: 0 });
  const paths = [first.path, second.path];
  expect(new Set(paths).size).toBe(2);
  await expect(first.finish()).resolves.toMatchObject({ code: 1 });
  const reused = await visit();
  expect(reused).toBe(first.path);
  expect(reused).not.toBe(second.path);
  expect(paths).not.toContain(await visit({ ...spec, config: "test/b.ts" }));
  await second.finish();
});

it.each(["child-only", "rejected"])(
  "retires a %s lease without reusing its directory",
  async (mode) => {
    const { lease: run, visit } = cacheFixture();
    let retired: string | undefined;
    const attempt = run(spec, async (assigned) => {
      retired = assigned.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH;
      if (mode === "rejected") {
        throw new Error("unverified descendants");
      }
      return { groupJoined: false };
    });
    if (mode === "rejected") {
      await expect(attempt).rejects.toThrow("unverified descendants");
    } else {
      await attempt;
    }
    for (let index = 0; index < 3; index += 1) {
      expect(await visit()).not.toBe(retired);
    }
  },
);
