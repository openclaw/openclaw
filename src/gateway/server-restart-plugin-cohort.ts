import { z } from "zod";
import type { UpdatePluginCohortCommitInput } from "../cli/update-cli/update-command-migrated-types.js";
import { stripGatewayServiceMarkerEnv } from "../cli/update-cli/update-command-service-env.js";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../config/future-version-guard.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { inspectPluginCohortRecoveriesAsync } from "../infra/update-run-recovery-store.js";
import { pluginCohortRecoveryMatchesSource } from "../infra/update-run-recovery.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../infra/update-run-timeouts.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";

const resultSchema = z.strictObject({
  runId: z.uuid(),
  transactionId: z.uuid(),
  configPaths: z.array(z.string()).max(4096),
});

/** Called by the existing post-ready sentinel owner before Gateway-owned completion. */
export async function commitRestartPluginCohort(
  runId: string,
  params: {
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    assertCurrent: () => void;
  },
): Promise<void> {
  params.assertCurrent();
  const pair = (await inspectPluginCohortRecoveriesAsync({ env: params.env })).find(
    (entry) => entry.cohort.runId === runId,
  );
  params.assertCurrent();
  if (!pair) {
    return;
  }
  if (!pluginCohortRecoveryMatchesSource(pair, { env: params.env })) {
    throw new Error("Plugin cohort commit selected a different Gateway state or configuration.");
  }
  const root = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!root) {
    throw new Error("Plugin cohort commit cannot locate the installed Gateway runtime.");
  }
  const input: UpdatePluginCohortCommitInput = {
    runId,
    transactionId: pair.cohort.transactionId,
    installKey: pair.cohort.installKey,
  };
  const env = stripGatewayServiceMarkerEnv({ ...params.env, [UPDATE_RUN_ID_ENV]: runId });
  delete env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
  params.assertCurrent();
  const result = await runUtf8CommandWithTimeout(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl({ ...runtimeProcessEntrypoints.updateMigratedFinalize, root }),
        process.execPath,
      ),
      "--commit-plugin-cohort",
    ],
    {
      cwd: root,
      baseEnv: {},
      env,
      signal: params.signal,
      timeoutMs: UPDATE_RUNNER_TIMEOUT_MS,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      terminateOnOutputLimit: true,
      input: JSON.stringify(input),
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 64 * 1024 },
    },
  );
  if (result.cleanup === "forced" || result.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  params.assertCurrent();
  if (
    result.code !== 0 ||
    result.termination !== "exit" ||
    result.cleanup !== "normal" ||
    result.outputLimitExceeded ||
    result.outputErrorStream
  ) {
    throw new Error(
      `Plugin cohort commit remains pending: ${result.stderr.trim() || "installed worker did not confirm settlement"}`,
    );
  }
  const settled = resultSchema.parse(JSON.parse(result.stdout));
  if (settled.runId !== runId || settled.transactionId !== input.transactionId) {
    throw new Error("Plugin cohort commit returned a different operation.");
  }
}
