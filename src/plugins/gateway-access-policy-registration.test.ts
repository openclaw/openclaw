import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { pluginRetentionEntrypoints } from "./retention-runtime.test-support.js";

it.each(["retirement", "live-grant"])(
  "preserves native registered access-signal ownership through %s",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(pluginRetentionEntrypoints.accessPolicy),
        ),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);
