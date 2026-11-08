import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

it.for(["sweeper", "scheduler"] as const)(
  "releases completed caller context while the real %s timer remains alive",
  async (resource, { signal }) => {
    const result = await runNodeScript(
      (workerArgv) => [
        "--expose-gc",
        ...workerArgv(
          resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.lifecycleTimerRetention),
        ),
        resource,
      ],
      { ...process.env, NODE_OPTIONS: "" },
      undefined,
      { signal, requireProcessTreeExit: process.platform !== "win32", maxBuffer: 64 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ resource, collected: 2 });
  },
);
