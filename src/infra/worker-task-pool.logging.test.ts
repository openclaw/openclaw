import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "./worker-task-pool-runtime.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("keeps SQLite worker diagnostics off the parent JSON stdout", async () => {
  const home = directories.make("worker-json-logging-");
  const configPath = path.join(home, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ logging: { file: path.join(home, "worker.log") } }),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.logging)),
    {
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        OPENCLAW_STATE_DIR: home,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_LOG_LEVEL: "debug",
        TSX_DISABLE_CACHE: "1",
        NO_COLOR: "1",
      },
    },
  );
  expect(JSON.parse(stdout)).toEqual({ value: "ready" });
  expect(stderr).toContain("[state/sqlite] SQLite read-only snapshot for synthetic.sqlite:");
});
