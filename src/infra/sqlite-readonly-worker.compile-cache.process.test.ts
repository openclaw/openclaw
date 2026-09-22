import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { sqliteReadOnlyCompileCacheParentEntrypoint } from "./sqlite-readonly-worker.compile-cache-runtime.test-support.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

describe.each(["sync", "async", "scoped"] as const)("SQLite child compile cache (%s)", (mode) => {
  it.for([
    { label: "active programmatic cache", active: true, cache: undefined, disable: undefined },
    { label: "explicit cache", active: true, cache: "explicit", disable: undefined },
    { label: "empty explicit cache", active: true, cache: "", disable: undefined },
    { label: "disabled cache", active: true, cache: undefined, disable: "1" },
    { label: "empty disable policy", active: true, cache: undefined, disable: "" },
    { label: "unavailable cache", active: false, cache: undefined, disable: undefined },
  ] as const)("preserves $label through the real worker", async (testCase, { signal }) => {
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
          ),
          root,
          mode,
          testCase.active ? "1" : "0",
          testCase.cache ?? "unset",
          testCase.disable ?? "unset",
        ],
        env,
        undefined,
        { signal, requireProcessTreeExit: process.platform !== "win32", maxBuffer: 1024 * 1024 },
      ),
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("readonly-cache:verified");
  });
});
