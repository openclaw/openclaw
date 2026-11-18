import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { updateExecutorNativeEntrypoints as updateEntrypoints } from "./update-cli/update-command-executor-native-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("failed update result output", () => {
  it("drains a noisy failure result before exiting so its recovery verdict reaches the helper", async () => {
    const root = tempDirs.make("openclaw-update-result-output-");
    const state = path.join(root, "state");
    await fs.mkdir(state);
    const result = await runCliProcessChild({
      nodeArgs: resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(updateEntrypoints.resultOutput)),
      env: {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });
    const failure = formatCliProcessFailure({ reason: "noisy failed update", ...result });
    expect(result, failure).toMatchObject({ signal: null, code: 79 });
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      status: "error",
      reason: "doctor-failed",
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    });
    expect(output.steps.slice(0, 40)).toEqual(
      Array.from({ length: 40 }, (_, index) => ({
        name: `update step ${index}`,
        command: "fixture",
        cwd: state,
        durationMs: 1,
        exitCode: index === 39 ? 1 : 0,
        stderrTail: "diagnostic ".repeat(727),
      })),
    );
    expect(output.steps.slice(40)).toEqual([
      {
        name: "gateway recovery verification",
        command: "gateway verification",
        cwd: state,
        durationMs: expect.any(Number),
        exitCode: 1,
        failureFacts: [
          {
            check: "gateway-recovery",
            code: "gateway-probe-failed",
            message: "The installed Gateway version could not be read for recovery verification.",
          },
        ],
      },
    ]);
  });
});
