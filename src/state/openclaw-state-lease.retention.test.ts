import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { stateLeaseRetentionRuntimeEntrypoint } from "./openclaw-state-lease-runtime.test-support.js";

it.each(["completed", "completed-worker", "paused"])(
  "releases caller state after lease timers are %s",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(stateLeaseRetentionRuntimeEntrypoint)),
        scenario,
      ],
      { timeout: 30_000 },
    );
  },
  35_000,
);
