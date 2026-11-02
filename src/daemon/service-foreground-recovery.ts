import { hasErrnoCode } from "../infra/errno.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { sleep } from "../utils/sleep.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import type { GatewayService, GatewayServiceControlArgs } from "./service-types.js";
import { assertSystemdServiceActionAllowed } from "./systemd-lifecycle.js";
import {
  assertNoSystemGatewayOwnershipForActivation,
  findInstalledSystemdGatewayScope,
} from "./systemd-scope.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

/** Recovery hands this installation's foreground state owner back to systemd. */
export async function recoverForegroundGatewayForService(
  service: GatewayService,
  args: GatewayServiceControlArgs,
): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  const env = args.env ?? process.env;
  const signal = args.deadline?.signal ?? getAsyncWorkSignal();
  await withGatewayServiceOperationLock(env, async (assertNative) => {
    const assertCurrent = () => {
      assertNative();
      args.assertCurrent?.();
      signal?.throwIfAborted();
    };
    const command = await service.readCommand(env, { requireEffective: true });
    assertCurrent();
    if (!command) {
      return;
    }
    const ownerEnv = mergeGatewayServiceEnv(env, command);
    const owner = readGatewayOwnerLease({ env: ownerEnv, current: true });
    if (
      !owner ||
      owner.state !== "live" ||
      owner.mode !== "foreground" ||
      owner.supervisor ||
      owner.pid === process.pid
    ) {
      return;
    }
    const target = args.systemdIdentity ?? (await findInstalledSystemdGatewayScope(env));
    assertCurrent();
    // Preserve a serving foreground owner when this caller cannot start its replacement.
    assertSystemdServiceActionAllowed(target, "restart");
    if (target?.scope !== "system") {
      await assertNoSystemGatewayOwnershipForActivation({
        ...env,
        OPENCLAW_SYSTEMD_UNIT: target?.unitName ?? `${resolveSystemdServiceName(env)}.service`,
      });
      assertCurrent();
    }
    // A current lease identifies our state owner; a fresh start time excludes PID reuse.
    if (
      owner.startedAt === null ||
      getFileLockProcessStartTime(owner.pid, ownerEnv) !== owner.startedAt
    ) {
      throw new Error(`Foreground Gateway pid ${owner.pid} identity changed; process preserved.`);
    }
    try {
      process.kill(owner.pid, "SIGTERM");
    } catch (error) {
      if (!hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
    }
    const deadline =
      performance.now() +
      Math.min(
        GATEWAY_SERVICE_STOP_TIMEOUT_MS,
        args.deadline?.remainingMs() ?? GATEWAY_SERVICE_STOP_TIMEOUT_MS,
      );
    while (isPidAlive(owner.pid)) {
      assertCurrent();
      if (performance.now() >= deadline) {
        throw new Error(
          `Foreground Gateway pid ${owner.pid} has not stopped; the managed service was not started. Inspect its shutdown logs and retry recovery.`,
        );
      }
      await sleep(Math.min(100, deadline - performance.now()), signal);
    }
    assertCurrent();
    args.stdout.write(
      `Stopped foreground Gateway pid ${owner.pid}; recovering through ${service.label}.\n`,
    );
  });
}
