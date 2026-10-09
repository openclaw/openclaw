/**
 * Bounds the CLI's routed handshake with a foreign Gateway state owner.
 *
 * `runWithLocalStateOwner` forwards state work to the Gateway that owns this
 * state root. That round-trip is only useful while the Gateway's event loop is
 * live: a Gateway that is mid-startup (loading plugin ES modules synchronously
 * on its main thread) or otherwise starved cannot answer, and an oversized
 * ceiling leaves the operator with a silent, multi-minute wait and no output.
 *
 * Keep the ceiling generous enough for genuine state mutations, but bounded so
 * a starved Gateway fails the command instead of hanging it. Override with
 * `OPENCLAW_CLI_STATE_OWNER_TIMEOUT_MS` when a specific operation legitimately
 * needs longer.
 */
export const DEFAULT_CLI_STATE_OWNER_GATEWAY_TIMEOUT_MS = 120_000;

export function resolveCliStateOwnerGatewayTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_CLI_STATE_OWNER_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_CLI_STATE_OWNER_GATEWAY_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `OPENCLAW_CLI_STATE_OWNER_TIMEOUT_MS must be a positive integer. Got: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
