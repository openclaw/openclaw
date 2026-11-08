import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatCliProcessFailure,
  getCliProcessTestTimeout,
  runCliProcessChild,
} from "../../src/cli/cli-process-child.test-helpers.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

export function registerGatewayThreadDatabaseProbeTests(params: {
  suiteName: string;
  testName: string;
  dirPrefix: string;
  entrypoint: Parameters<typeof resolveRuntimeWorkerUrl>[0];
  connectionEnv: string;
  failureReason: string;
  successPrefix: string;
}) {
  const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
  const connection = typeof configured === "string" ? configured : undefined;
  const dirs = useAutoCleanupTempDirTracker(afterAll);
  const childTimeoutMs = 60_000;

  describe.skipIf(!connection)(params.suiteName, () => {
    it.each(["postgres", "sqlite"] as const)(
      params.testName,
      async (engine) => {
        const root = dirs.make(params.dirPrefix);
        const stateDir = path.join(root, "state");
        fs.mkdirSync(stateDir);
        const configPath = path.join(root, "openclaw.json");
        fs.writeFileSync(configPath, "{}");
        const entry = resolveRuntimeWorkerUrl(params.entrypoint);
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
            [params.connectionEnv]: connection,
          },
          timeoutMs: childTimeoutMs,
        });
        expect(
          result.code,
          formatCliProcessFailure({ reason: params.failureReason, ...result }),
        ).toBe(0);
        expect(result.stdout).toContain(`${params.successPrefix}${engine}`);
      },
      getCliProcessTestTimeout(childTimeoutMs),
    );
  });
}
