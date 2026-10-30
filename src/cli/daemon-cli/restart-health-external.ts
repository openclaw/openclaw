import { createConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import {
  type GatewayLockIdentity,
  isSameGatewayLockIdentity,
  readActiveGatewayLockIdentity,
} from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";
import {
  inspectGatewayPortHealth,
  resolveGatewayRestartProbeContext,
} from "./restart-health-probe.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
} from "./restart-health.constants.js";
import type { GatewayPortHealthSnapshot } from "./restart-health.types.js";

export async function waitForGatewayHealthyListener(params: {
  port: number;
  env?: NodeJS.ProcessEnv;
  attempts?: number;
  delayMs?: number;
  previousLockIdentity?: GatewayLockIdentity;
  waitIndefinitelyForPreviousOwner?: boolean;
  signal?: AbortSignal;
}): Promise<GatewayPortHealthSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;
  const previousLockIdentity = params.previousLockIdentity;

  const probeContext = await resolveGatewayRestartProbeContext(
    params.env,
    undefined,
    params.signal,
  ).catch(() => ({
    auth: undefined,
    config: {},
  }));
  params.signal?.throwIfAborted();
  const configuredProbe = createConfiguredGatewayLocalProbe(probeContext.config);

  let attempt = 0;
  let expectedListenerPid: number | undefined;
  if (previousLockIdentity) {
    const waitIndefinitelyForPreviousOwner = params.waitIndefinitelyForPreviousOwner === true;
    let attemptsUsed = 0;
    let previousOwnerReleased = false;
    for (;;) {
      // An accepted interrupt stops the wait; the root signal owner records the exit status.
      params.signal?.throwIfAborted();
      // A failed inspection is not evidence that the previous owner released its lock.
      const currentLockIdentity = await readActiveGatewayLockIdentity({ env: params.env }).catch(
        () => null,
      );
      params.signal?.throwIfAborted();
      if (
        !previousOwnerReleased &&
        currentLockIdentity !== null &&
        (!currentLockIdentity ||
          !isSameGatewayLockIdentity(previousLockIdentity, currentLockIdentity))
      ) {
        previousOwnerReleased = true;
        if (waitIndefinitelyForPreviousOwner) {
          attemptsUsed = 0;
        }
      }
      if (
        previousOwnerReleased &&
        currentLockIdentity &&
        !isSameGatewayLockIdentity(previousLockIdentity, currentLockIdentity)
      ) {
        attempt = attemptsUsed;
        expectedListenerPid = currentLockIdentity.pid;
        break;
      }
      if (!waitIndefinitelyForPreviousOwner || previousOwnerReleased) {
        if (attemptsUsed >= attempts) {
          return {
            portUsage: {
              port: params.port,
              status: "unknown",
              listeners: [],
              hints: [],
              errors: [
                `Previous gateway lock owner ${previousLockIdentity.ownerId ?? previousLockIdentity.pid} is still active.`,
              ],
            },
            healthy: false,
          };
        }
        attemptsUsed += 1;
      }
      await sleep(delayMs, params.signal);
    }
  }

  for (;;) {
    // An accepted interrupt stops the wait; the root signal owner records the exit status.
    params.signal?.throwIfAborted();
    const snapshot = await inspectGatewayPortHealth({
      port: params.port,
      auth: probeContext.auth,
      config: probeContext.config,
      configuredProbe,
      expectedListenerPid,
      signal: params.signal,
    });
    // Inspection runs an in-flight probe; an interrupt during it must not report health.
    params.signal?.throwIfAborted();
    if (!snapshot.healthy && attempt < attempts) {
      attempt += 1;
      await sleep(delayMs, params.signal);
      continue;
    }
    return snapshot;
  }
}
