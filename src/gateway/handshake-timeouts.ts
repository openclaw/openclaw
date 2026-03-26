export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 10_000;
export const MIN_CONNECT_CHALLENGE_TIMEOUT_MS = 250;
export const MAX_CONNECT_CHALLENGE_TIMEOUT_MS = DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;

export function clampConnectChallengeTimeoutMs(timeoutMs: number): number {
  return Math.max(
    MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
    Math.min(MAX_CONNECT_CHALLENGE_TIMEOUT_MS, timeoutMs),
  );
}

export function resolveConnectChallengeTimeoutMs(timeoutMs?: number | null): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? clampConnectChallengeTimeoutMs(timeoutMs)
    : DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
}

export function getPreauthHandshakeTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const configuredTimeout =
    env.OPENCLAW_HANDSHAKE_TIMEOUT_MS || (env.VITEST && env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
  if (configuredTimeout) {
    const parsed = Number(configuredTimeout);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
}
