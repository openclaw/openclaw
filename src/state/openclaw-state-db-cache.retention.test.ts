import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("releases closed shared database wrappers after path and global retirement", () => {
  const stateDir = tempDirs.make("openclaw-state-retention-");
  const moduleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
  const cacheModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabaseCache);
  const script = `
    import assert from "node:assert/strict";
    import {
      closeOpenClawStateDatabase,
      openOpenClawStateDatabase,
    } from ${JSON.stringify(moduleUrl.href)};
    import { closeOpenClawStateDatabaseByPath } from ${JSON.stringify(cacheModuleUrl.href)};

    const control = new WeakRef({ uncached: true });
    function retire(byPath) {
      let owner = openOpenClawStateDatabase();
      const ref = new WeakRef(owner.db);
      for (let i = 0; i < 3; i++) {
        assert.equal(openOpenClawStateDatabase(), owner);
      }
      if (byPath) {
        assert.equal(closeOpenClawStateDatabaseByPath(owner.path), true);
      } else {
        closeOpenClawStateDatabase();
      }
      assert.equal(owner.db.isOpen, false);
      owner = undefined;
      return ref;
    }
    // WeakRef targets stay live through the task that creates them. Finish that
    // task before forcing collection so the check measures cache ownership.
    const refs = await new Promise(resolve =>
      setImmediate(() => resolve([retire(true), retire(false)]))
    );
    for (let i = 0; i < 30; i++) {
      await new Promise(setImmediate);
      globalThis.gc();
    }
    assert.equal(control.deref(), undefined, "the unowned GC control must be collected");
    process.stdout.write(JSON.stringify(refs.map(ref => ref.deref() === undefined)));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([true, true]);
});
