import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  formatCliProcessFailure,
  getCliProcessTestTimeout,
  runCliProcessChild,
} from "../../cli/cli-process-child.test-helpers.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { stateLeasePostgresRuntimeEntrypoint } from "../../state/openclaw-state-lease-runtime.test-support.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);
const childTimeoutMs = 60_000;

describe.skipIf(!connection)("native plugin lifecycle leases", () => {
  it.each(["postgres", "sqlite"] as const)(
    "verifies and renews %s ownership on the Gateway thread without admitting unrelated SQL",
    async (engine) => {
      const root = dirs.make("native-plugin-lease-");
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const configPath = path.join(root, "openclaw.json");
      fs.writeFileSync(configPath, "{}");
      const entry = resolveRuntimeWorkerUrl(stateLeasePostgresRuntimeEntrypoint);
      const result = await runCliProcessChild({
        nodeExecutable: resolveTestNodeExecPath(),
        nodeArgs: [...resolveRuntimeWorkerArgv(entry, resolveTestNodeExecPath()), engine],
        nodeArgsPolicy: "caller",
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_TEST_LEASE_PG_CONNECTION: connection,
        },
        timeoutMs: childTimeoutMs,
      });
      expect(
        result.code,
        formatCliProcessFailure({ reason: "Native lease process failed", ...result }),
      ).toBe(0);
      expect(result.stdout).toContain(
        `native lease verification, renewal and refusal passed: ${engine}`,
      );
    },
    getCliProcessTestTimeout(childTimeoutMs),
  );
});
