import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { sqliteReadOnlyCompileCacheParentEntrypoint } from "./sqlite-readonly-worker.compile-cache-runtime.test-support.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

// The shared cache policy matrix lives in sqlite-worker-store.compile-cache.test.ts.
it.for(["sync", "async", "scoped"] as const)(
  "inherits the owned compile cache through the real %s worker",
  async (mode, { signal }) => {
    const root = fixture.createTempDir("openclaw-sqlite-child-cache-");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
    };
    delete env.NODE_COMPILE_CACHE;
    delete env.NODE_DISABLE_COMPILE_CACHE;
    delete env.NODE_OPTIONS;
    const result = await fixture.track(
      runNodeScript(
        [
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(sqliteReadOnlyCompileCacheParentEntrypoint),
            resolveTestNodeExecPath(),
          ),
          root,
          mode,
        ],
        env,
        undefined,
        { signal, requireProcessTreeExit: process.platform !== "win32", maxBuffer: 1024 * 1024 },
      ),
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("readonly-cache:verified");
  },
);
