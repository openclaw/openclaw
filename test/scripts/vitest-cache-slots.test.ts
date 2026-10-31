import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createVitestCacheSlots } from "../../scripts/lib/vitest-cache-slots.mts";
import { applyDefaultVitestCachePaths } from "../../scripts/test-projects.test-support.mts";
import { createDeferred } from "../helpers/promise.js";

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

it("reuses a failed command's joined cache while a same-config lease and another config remain active", async () => {
  const { hold, visit } = cacheFixture();
  const first = hold({ ...joined, code: 1 }, { ...spec, config: "a.config.ts" });
  const peer = hold(joined, { ...spec, config: "a.config.ts" });
  await expect(first.finish()).resolves.toMatchObject({ code: 1 });
  const third = hold(joined, { ...spec, config: "c.config.ts" });
  const reused = await visit({ ...spec, config: "a.config.ts" });
  expect(reused).toBe(first.path);
  expect(await cacheFixture().visit({ ...spec, config: "a.config.ts" })).toBe(first.path);
  expect(reused).not.toBe(third.path);
  expect(new Set([first.path, peer.path, third.path]).size).toBe(3);
  await peer.finish();
});

it("isolates concurrent aliases and reuses their joined slot", async () => {
  const { hold, visit } = cacheFixture();
  const first = hold(joined);
  const alias = {
    ...spec,
    config: "test/x/../a.ts",
    cacheAssignment: { ...spec.cacheAssignment, root: "/cache/x/.." },
  };
  expect(await visit(alias)).not.toBe(first.path);
  await first.finish();
  expect(await visit(alias)).toBe(first.path);
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
    const alias = await visit(
      { ...spec, cacheAssignment: { ...spec.cacheAssignment, root: "/alias" } },
      false,
    );
    expect(
      new Set([retired!, alias, await visit()].map((value) => path.basename(value))).size,
    ).toBe(3);
    for (let index = 0; index < 3; index += 1) {
      expect(await visit()).not.toBe(retired);
    }
  },
);
