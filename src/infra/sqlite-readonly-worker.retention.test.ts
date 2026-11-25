import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it.for(["native", "broker"] as const)(
  "releases completed callers while reusing the real %s SQLite read worker",
  async (transport, { signal, skip }) => {
    if (transport === "broker" && process.platform === "win32") {
      skip();
    }
    const root = fixture.createTempDir("openclaw-sqlite-read-retention-");
    const result = await fixture.track(
      runNodeScript(
        (workerArgv) => [
          "--expose-gc",
          ...workerArgv(resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.sqliteReadRetention)),
          root,
          transport,
        ],
        { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root, NODE_OPTIONS: "" },
        undefined,
        { signal, requireProcessTreeExit: process.platform !== "win32", maxBuffer: 64 * 1024 },
      ),
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ transport, collected: 6, reused: true });
  },
);
