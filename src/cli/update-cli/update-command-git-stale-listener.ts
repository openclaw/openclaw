import { isGatewayServiceStateLive } from "../../daemon/service-runtime.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { inspectSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import {
  terminateStaleGatewayPids,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import type { UpdateServiceRestartParams } from "./update-command-service-context-types.js";

/** No owner row names the old listener. Bind it to this profile before stale-PID recovery. */
export async function recoverStaleGitListener(
  params: UpdateServiceRestartParams,
  health: GatewayRestartSnapshot,
  reinspect: () => Promise<GatewayRestartSnapshot>,
  assertCurrent: () => void,
): Promise<GatewayRestartSnapshot> {
  const stalePid = (snapshot: GatewayRestartSnapshot) => {
    const { runtime, portUsage } = snapshot;
    const [pid] = snapshot.staleGatewayPids;
    // stale-pids already excludes a healthy listener, an observed owner and a protected hold.
    return !snapshot.healthy &&
      snapshot.waitOutcome === "stale-pids" &&
      snapshot.staleGatewayPids.length === 1 &&
      snapshot.staleConnection &&
      runtime.status === "stopped" &&
      !runtime.missingUnit &&
      !runtime.inspectionFailure &&
      !runtime.inspectionReason &&
      !runtime.systemLaunchDaemon &&
      !isGatewayServiceStateLive({ running: false, runtime }) &&
      portUsage.status === "busy" &&
      portUsage.listeners.length > 0 &&
      portUsage.port === params.gatewayPort &&
      !portUsage.errors?.length &&
      portUsage.listeners.every((listener) => listener.pid === pid)
      ? pid
      : undefined;
  };
  const pid = stalePid(health);
  if (
    !pid ||
    params.serviceUpdateVerdict?.kind !== "owned" ||
    (params.opts.run && !params.opts.run.executorFence)
  ) {
    return health;
  }
  const ancestry = inspectSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true });
  if (!ancestry.complete || ancestry.pids.has(pid)) {
    return health;
  }
  const { serviceEnv: env, timeoutMs } = params;
  const context = { env, timeoutMs, signal: params.opts.run?.deadline?.signal };
  const lock = await readActiveGatewayLockIdentity({ ...context, requireInspection: true });
  assertCurrent();
  if (
    lock?.pid !== pid ||
    lock.port !== params.gatewayPort ||
    lock.startTime === undefined ||
    getFileLockProcessStartTime(pid, env) !== lock.startTime
  ) {
    return health;
  }
  const current = await reinspect();
  if (stalePid(current) !== pid) {
    return current;
  }
  // The PID may recycle during the cleanup owner's first asynchronous lease read.
  // Bind its first signal to the lock; its own start checks guard later group members.
  let firstSignal = true;
  const terminated = await terminateStaleGatewayPids([pid], {
    env,
    assertCurrent: () => {
      assertCurrent();
      if (firstSignal && getFileLockProcessStartTime(pid, env) !== lock.startTime) {
        throw new Error(
          "Refusing stale Gateway cleanup: the process start time could not be verified against the profile lock.",
        );
      }
      firstSignal = false;
    },
  });
  assertCurrent();
  return terminated.length ? await reinspect() : current;
}
