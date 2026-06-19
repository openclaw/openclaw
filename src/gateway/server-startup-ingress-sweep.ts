import { recoverAllStaleChannelIngressClaims } from "../channels/message/ingress-queue.js";
import {
  consumeGatewayRestartSkipStartupIngressSweepEnv,
  readGatewayRestartHandoffSync,
} from "../infra/restart-handoff.js";

type IngressSweepLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Recover stale channel ingress queue claims at gateway startup.
 *
 * Runs during `prepareGatewayPluginBootstrap`, before `startChannels()`. It is
 * limited to starts that cannot still have a previous in-process channel
 * lifecycle settling: unclean exits leave claimed rows behind, while SIGUSR1 or
 * supervised restarts can leave old channel handlers alive during the next start.
 *
 * Best-effort and non-blocking: if the sweep fails, gateway startup continues
 * normally. After a crash, claimed rows in `channel_ingress_events` can remain
 * in "claimed" state indefinitely, silently blocking channel message processing.
 *
 * @see https://github.com/openclaw/openclaw/issues/90945
 */
export async function runStartupIngressClaimSweep(params: {
  env?: NodeJS.ProcessEnv;
  inProcessRestart?: boolean;
  log: IngressSweepLogger;
  deps?: {
    consumeGatewayRestartSkipStartupIngressSweepEnv?: typeof consumeGatewayRestartSkipStartupIngressSweepEnv;
    recoverAllStaleChannelIngressClaims?: typeof recoverAllStaleChannelIngressClaims;
    readGatewayRestartHandoffSync?: typeof readGatewayRestartHandoffSync;
  };
}): Promise<void> {
  if (params.inProcessRestart) {
    params.log.info(
      "gateway: skipping stale ingress claim sweep during SIGUSR1 in-process restart",
    );
    return;
  }
  const sweep =
    params.deps?.recoverAllStaleChannelIngressClaims ?? recoverAllStaleChannelIngressClaims;
  const env = params.env ?? process.env;
  const consumeSkipEnv =
    params.deps?.consumeGatewayRestartSkipStartupIngressSweepEnv ??
    consumeGatewayRestartSkipStartupIngressSweepEnv;
  if (consumeSkipEnv(env)) {
    params.log.info("gateway: skipping stale ingress claim sweep during spawned restart handoff");
    return;
  }
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
