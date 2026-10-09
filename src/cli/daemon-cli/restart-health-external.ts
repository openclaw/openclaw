import { createConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
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
import { waitForGatewayLockReplacement } from "./restart-lock-replacement.js";

export async function waitForGatewayHealthyListener(params: {
  port: number;
  env?: NodeJS.ProcessEnv;
  attempts?: number;
  delayMs?: number;
  previousLockIdentity?: GatewayLockIdentity;
  waitIndefinitelyForPreviousOwner?: boolean;
}): Promise<GatewayPortHealthSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;
  const previousLockIdentity = params.previousLockIdentity;

  const probeContext = await resolveGatewayRestartProbeContext(params.env).catch(() => ({
    auth: undefined,
    config: {},
  }));
  const configuredProbe = createConfiguredGatewayLocalProbe(probeContext.config);

  let attempt = 0;
  let expectedListenerPid: number | undefined;
  if (previousLockIdentity) {
    const replacement = await waitForGatewayLockReplacement({
      previousLockIdentity,
      env: params.env,
      attempts,
      delayMs,
      waitIndefinitelyForPreviousOwner: params.waitIndefinitelyForPreviousOwner === true,
    });
    if (replacement.status === "timeout") {
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
    attempt = replacement.attemptsUsed;
    expectedListenerPid = replacement.lockIdentity.pid;
  }

  for (;;) {
    const snapshot = await inspectGatewayPortHealth({
      port: params.port,
      auth: probeContext.auth,
      config: probeContext.config,
      configuredProbe,
      expectedListenerPid,
    });
    if (!snapshot.healthy && attempt < attempts) {
      attempt += 1;
      await sleep(delayMs);
      continue;
    }
    return snapshot;
  }
}
