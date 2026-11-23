import { readBestEffortConfig, resolveGatewayPort } from "../../config/config.js";
import { createConfigIO } from "../../config/io.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import {
  createManagedUpdateRequesterAuthority,
  prepareUpdateRequesterIdentity,
  type UpdateRequester,
} from "../../infra/update-requester-authority.js";
import { ignoreNonCleanupCommandError } from "../../process/exec-result.js";
import { waitForGatewayHealthyRestart } from "./restart-health.js";

export async function resolveGatewayLifecycleContext(
  service = resolveGatewayService(),
  requireEffective = false,
) {
  const command = requireEffective
    ? await service.readCommand(process.env, { requireEffective: true })
    : await service.readCommand(process.env).catch(ignoreNonCleanupCommandError);
  if (requireEffective && !command) {
    throw new Error(
      "Updated gateway service could not be inspected; run `openclaw gateway status --deep`.",
    );
  }
  const env = mergeGatewayServiceEnv(process.env, command);
  const config = await createConfigIO({
    env,
    observe: false,
    pluginValidation: "skip",
    suppressFutureVersionWarning: true,
  })
    .readBestEffortConfig()
    .catch(() => undefined);
  const port = parseTcpPortFromArgs(command?.programArguments) ?? resolveGatewayPort(config, env);
  return { port, env, config, command };
}

export async function resolveGatewayConfigPorts() {
  const config = await readBestEffortConfig({ observe: false }).catch(() => undefined);
  return {
    config,
    explicit: config?.gateway?.port,
    fallback: resolveGatewayPort(config, process.env),
  };
}

// The detached update helper imports this through the stable daemon CLI entry.
// Native manager acceptance alone never proves that a restored Gateway is ready.
export async function waitForGatewayUpdateRecovery(
  expectedVersion: string,
  expectedBuildId?: string,
  timeoutMs?: number,
) {
  if (!expectedVersion?.trim()) {
    throw new Error("Recovery Gateway version is unavailable.");
  }
  const service = resolveGatewayService();
  const { port, env } = await resolveGatewayLifecycleContext(service, true);
  return await waitForGatewayHealthyRestart({
    service,
    port,
    env,
    expectedVersion,
    expectedBuildId,
    timeoutMs,
    requireRunningService: true,
  });
}

// The helper keeps running while Doctor and database rollback take native exclusion.
// An idle WAL reader retained by its state-read worker would hold their shared lock.
async function releasingHelperStateReaders<T>(check: () => Promise<T>): Promise<T> {
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await check() };
  } catch (error) {
    outcome = { error };
  }
  const [{ closeOpenClawStateDatabaseWorkersByPathAsync }, { resolveOpenClawStateSqlitePath }] =
    await Promise.all([
      import("../../state/openclaw-state-db-cache.js"),
      import("../../state/openclaw-state-db.paths.js"),
    ]);
  try {
    await closeOpenClawStateDatabaseWorkersByPathAsync(resolveOpenClawStateSqlitePath());
  } catch (cleanupError) {
    throw "error" in outcome
      ? createSqliteLifecycleAggregateError(
          [outcome.error, cleanupError],
          "Update requester check and state reader release both failed.",
          outcome.error,
        )
      : cleanupError;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

// The helper rechecks external chat authority at update admission and activation.
export async function isManagedUpdateRequesterOwner(requester: UpdateRequester) {
  return await releasingHelperStateReaders(async () =>
    (await createManagedUpdateRequesterAuthority(requester)).isCurrent(),
  );
}

export async function prepareManagedUpdateRequesterIdentity(requester: UpdateRequester) {
  return await releasingHelperStateReaders(() => prepareUpdateRequesterIdentity(requester));
}
