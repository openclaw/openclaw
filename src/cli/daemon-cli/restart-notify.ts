import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";

export async function writeRestartSentinelFromEnvIfPresent(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const sessionKey = env.OPENCLAW_RESTART_NOTIFY_SESSION_KEY?.trim();
  if (!sessionKey) {
    return false;
  }

  const payload: RestartSentinelPayload = {
    kind: "restart",
    status: "ok",
    ts: Date.now(),
    sessionKey,
    deliveryContext:
      env.OPENCLAW_RESTART_NOTIFY_CHANNEL ||
      env.OPENCLAW_RESTART_NOTIFY_TO ||
      env.OPENCLAW_RESTART_NOTIFY_ACCOUNT_ID
        ? {
            channel: env.OPENCLAW_RESTART_NOTIFY_CHANNEL?.trim() || undefined,
            to: env.OPENCLAW_RESTART_NOTIFY_TO?.trim() || undefined,
            accountId: env.OPENCLAW_RESTART_NOTIFY_ACCOUNT_ID?.trim() || undefined,
          }
        : undefined,
    threadId: env.OPENCLAW_RESTART_NOTIFY_THREAD_ID?.trim() || undefined,
    message:
      env.OPENCLAW_RESTART_NOTIFY_MESSAGE?.trim() ||
      "OpenClaw restarted after an in-chat restart command. I'm back online.",
    doctorHint: formatDoctorNonInteractiveHint(env as Record<string, string | undefined>),
    stats: {
      mode: "daemon.restart",
      reason: "cli restart command",
    },
  };

  await writeRestartSentinel(payload, env);
  return true;
}
