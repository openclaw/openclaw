import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

it("reuses unchanged transform modules across reloads and observes edited code", async () => {
  await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "hooks-mapping.retention.test-support",
          distWorkerPath: "gateway/hooks-mapping.retention.test-support.js",
        }),
      ),
    ],
    { timeout: 20_000 },
  );
}, 25_000);
