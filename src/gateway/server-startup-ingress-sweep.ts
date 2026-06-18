import { recoverAllStaleChannelIngressClaims } from "../channels/message/ingress-queue.js";
import { readGatewayRestartHandoffSync } from "../infra/restart-handoff.js";

type IngressSweepLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Recover stale channel ingress queue claims at gateway startup.
 *
 * Runs during `prepareGatewayPluginBootstrap`, before `startChannels()`. It is
 * limited to fresh process starts without a supervised restart handoff: unclean
 * exits leave claimed rows behind, while graceful in-process restarts can leave
 * old channel handlers settling after the replacement process starts.
 *
 * Best-effort and non-blocking: if the sweep fails, gateway startup continues
 * normally. After a crash, claimed rows in `channel_ingress_events` can remain
 * in "claimed" state indefinitely, silently blocking channel message processing.
 *
 * @see https://github.com/openclaw/openclaw/issues/90945
 */
export async function runStartupIngressClaimSweep(params: {
  env?: NodeJS.ProcessEnv;
  log: IngressSweepLogger;
  deps?: {
    recoverAllStaleChannelIngressClaims?: typeof recoverAllStaleChannelIngressClaims;
    readGatewayRestartHandoffSync?: typeof readGatewayRestartHandoffSync;
  };
}): Promise<void> {
  const sweep =
    params.deps?.recoverAllStaleChannelIngressClaims ?? recoverAllStaleChannelIngressClaims;
  const env = params.env ?? process.env;
  const readHandoff = params.deps?.readGatewayRestartHandoffSync ?? readGatewayRestartHandoffSync;
  if (readHandoff(env)) {
    params.log.info(
      "gateway: skipping stale ingress claim sweep during supervised restart handoff",
    );
    return;
  }
  try {
    await sweep({
      env,
      log: { info: (msg) => params.log.info(msg) },
    });
  } catch (err) {
    params.log.warn(
      `gateway: stale ingress claim sweep failed during startup; continuing: ${String(err)}`,
    );
  }
}
