import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it.each(["completed", "completed-worker", "paused"])(
  "releases caller state after lease timers are %s",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./openclaw-state-lease.retention.test-support.ts", import.meta.url)),
        scenario,
      ],
      { timeout: 30_000 },
    );
  },
  35_000,
);
