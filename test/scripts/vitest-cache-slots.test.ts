import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVitestCacheSlots } from "../../scripts/lib/vitest-cache-slots.mts";
import {
  applyDefaultVitestCachePaths,
  type VitestCacheAssignment,
} from "../../scripts/test-projects.test-support.mts";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { loadVitestPerformanceConfig } from "../vitest/vitest.performance-config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const spec = {
  config: "test/vitest/vitest.tooling.config.ts",
  env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/cache/original" },
  watchMode: false,
  cacheAssignment: { kind: "scheduler", root: "/cache" } satisfies VitestCacheAssignment,
};
const cachePath = (assigned: typeof spec) => assigned.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH;

describe("Vitest cache slot ownership", () => {
  it.skipIf(process.platform === "win32").each(["root", "default"] as const)(
    "reuses separately warmed configs through %s in serial, reordered, and parallel project runs",
    async (mode) => {
      const root = tempDirs.make("vitest-cache-layout-");
      const env: NodeJS.ProcessEnv =
        mode === "root" ? { OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: root } : {};
      const run = async (configs: string[], parallel: boolean, seed = false) => {
        const lease = createVitestCacheSlots("linux");
        const specs = applyDefaultVitestCachePaths(
          configs.map((config) => ({ config, env, watchMode: false })),
          { env, cwd: root },
        );
        const visit = (entry: (typeof specs)[number]) =>
          lease(entry, async (assigned) => {
            const directory = loadVitestPerformanceConfig(
              assigned.env,
              "linux",
              root,
            ).fsModuleCachePath!;
            const file = path.join(directory, `${entry.config}.js`);
            if (seed) {
              fs.mkdirSync(directory, { recursive: true });
              fs.writeFileSync(file, entry.config);
            } else {
              expect(fs.existsSync(file), `${entry.config} did not consume its warmed cache`).toBe(
                true,
              );
              expect(fs.readFileSync(file, "utf8")).toBe(entry.config);
            }
            return { groupJoined: true };
          });
        if (parallel) {
          await Promise.all(specs.map(visit));
        } else {
          for (const entry of specs) {
            await visit(entry);
          }
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
      return { groupJoined: true };
    });
  });

  it("reuses an idle config cache while another config occupies its former scheduler slot", async () => {
    const run = createVitestCacheSlots("linux");
    const first = createDeferred<{ groupJoined: boolean }>();
    const peer = createDeferred<{ groupJoined: boolean }>();
    const third = createDeferred<{ groupJoined: boolean }>();
    const paths: string[] = [];
    const start = (config: string, completion: typeof first) =>
      run({ ...spec, config }, (assigned) => {
        paths.push(cachePath(assigned));
        return completion.promise;
      });
    const pendingFirst = start("a.config.ts", first);
    const pendingPeer = start("b.config.ts", peer);
    let pendingThird: Promise<{ groupJoined: boolean }> | undefined;
    try {
      first.resolve({ groupJoined: true });
      await pendingFirst;
      pendingThird = start("c.config.ts", third);
      peer.resolve({ groupJoined: true });
      await pendingPeer;
      await run({ ...spec, config: "a.config.ts" }, async (assigned) => {
        expect(cachePath(assigned)).toBe(paths[0]);
        expect(cachePath(assigned)).not.toBe(paths[2]);
        return { groupJoined: true };
      });
      expect(new Set(paths).size).toBe(3);
    } finally {
      first.resolve({ groupJoined: true });
      peer.resolve({ groupJoined: true });
      third.resolve({ groupJoined: true });
      await Promise.all([pendingFirst, pendingPeer, pendingThird]);
    }
  });

  it("reuses lexical root and config aliases without sharing live leases", async () => {
    const run = createVitestCacheSlots("linux");
    const first = createDeferred<{ groupJoined: boolean }>();
    let firstPath: string | undefined;
    const pending = run(spec, (assigned) => {
      firstPath = cachePath(assigned);
      return first.promise;
    });
    const alias = {
      ...spec,
      config: "test/vitest/../vitest/vitest.tooling.config.ts",
      cacheAssignment: {
        kind: "scheduler",
        root: "/cache/unused/..",
      } satisfies VitestCacheAssignment,
    };
    try {
      await run(alias, async (assigned) => {
        expect(cachePath(assigned)).not.toBe(firstPath);
        return { groupJoined: true };
      });
      first.resolve({ groupJoined: true });
      await pending;
      await run(alias, async (assigned) => {
        expect(cachePath(assigned)).toBe(firstPath);
        return { groupJoined: true };
      });
    } finally {
      first.resolve({ groupJoined: true });
      await pending;
    }
  });

  it("keeps fresh indices distinct across root spellings even after an unjoined lease", async () => {
    const run = createVitestCacheSlots("linux");
    const first = createDeferred<{ groupJoined: boolean }>();
    const paths: string[] = [];
    const pending = run(spec, (assigned) => {
      paths.push(cachePath(assigned));
      return first.promise;
    });
    // These names may be symlinks to the same root; suffixes must remain distinct.
    const alias = {
      ...spec,
      cacheAssignment: { kind: "scheduler", root: "/cache-alias" } satisfies VitestCacheAssignment,
    };
    try {
      await run(alias, async (assigned) => {
        paths.push(cachePath(assigned));
        return { groupJoined: false };
      });
      first.resolve({ groupJoined: false });
      await pending;
      await run(spec, async (assigned) => {
        paths.push(cachePath(assigned));
        return { groupJoined: true };
      });
      expect(new Set(paths.map((value) => path.basename(value))).size).toBe(3);
    } finally {
      first.resolve({ groupJoined: false });
      await pending;
    }
  });

  it("holds concurrent leases until joined and reuses a failed command's completed slot", async () => {
    const run = createVitestCacheSlots("linux");
    const first = createDeferred<{ groupJoined: boolean; code: number }>();
    const second = createDeferred<{ groupJoined: boolean; code: number }>();
    const paths: string[] = [];
    const pending = [first, second].map((completion) =>
      run(spec, (assigned) => {
        paths.push(cachePath(assigned));
        return completion.promise;
      }),
    );
    expect(new Set(paths).size).toBe(2);
    first.resolve({ groupJoined: true, code: 1 });
    await expect(pending[0]).resolves.toMatchObject({ code: 1 });
    await run(spec, async (assigned) => {
      expect(cachePath(assigned)).toBe(paths[0]);
      expect(cachePath(assigned)).not.toBe(paths[1]);
      return { groupJoined: true };
    });
    await run({ ...spec, config: "test/vitest/vitest.cli.config.ts" }, async (assigned) => {
      expect(paths).not.toContain(cachePath(assigned));
      return { groupJoined: true };
    });
    second.resolve({ groupJoined: true, code: 0 });
    await pending[1];
  });

  it.each(["child-only", "rejected"])(
    "retires a %s lease without reusing its directory",
    async (mode) => {
      const run = createVitestCacheSlots("linux");
      let retired: string | undefined;
      const attempt = run(spec, async (assigned) => {
        retired = cachePath(assigned);
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
        await run(spec, async (assigned) => {
          expect(cachePath(assigned)).not.toBe(retired);
          return { groupJoined: true };
        });
      }
    },
  );

  it.each(["caller", "unassigned", "watch", "windows"])(
    "preserves the %s cache owner",
    async (mode) => {
      const input = {
        ...spec,
        watchMode: mode === "watch",
        cacheAssignment:
          mode === "unassigned"
            ? undefined
            : mode === "caller"
              ? { kind: "caller" as const }
              : spec.cacheAssignment,
      };
      const run = createVitestCacheSlots(mode === "windows" ? "win32" : "linux");
      await run(input, async (assigned) => {
        expect(assigned).toBe(input);
        return { groupJoined: false };
      });
    },
  );
});
