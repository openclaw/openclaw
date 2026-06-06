import { recoverAllStaleChannelIngressClaims } from "../channels/message/ingress-queue.js";

type IngressSweepLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Recover stale channel ingress queue claims at gateway startup.
 *
 * Runs during `prepareGatewayPluginBootstrap`, which completes before
 * `startChannels()`. At this point no channel workers are running yet, so all
 * claimed rows are stale from a previous crashed gateway session. The PID
 * liveness check is an additional guard for multi-gateway hosts.
 *
 * Best-effort and non-blocking: if the sweep fails, gateway startup continues
 * normally. After a crash, claimed rows in `channel_ingress_events` can remain
 * in "claimed" state indefinitely, silently blocking channel message processing.
 * This sweep releases claims whose owner PID is no longer alive.
 *
 * @see https://github.com/openclaw/openclaw/issues/90945
 */
export async function runStartupIngressClaimSweep(params: {
  env?: NodeJS.ProcessEnv;
  log: IngressSweepLogger;
  deps?: {
    recoverAllStaleChannelIngressClaims?: typeof recoverAllStaleChannelIngressClaims;
  };
}): Promise<void> {
  const sweep =
    params.deps?.recoverAllStaleChannelIngressClaims ?? recoverAllStaleChannelIngressClaims;
  try {
    await sweep({
      env: params.env ?? process.env,
      log: { info: (msg) => params.log.info(msg) },
    });
  } catch (err) {
    params.log.warn(
      `gateway: stale ingress claim sweep failed during startup; continuing: ${String(err)}`,
    );
  }
}
