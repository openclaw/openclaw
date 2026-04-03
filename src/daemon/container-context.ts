export function resolveDaemonContainerContext(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.OPENCLAW_CONTAINER_HINT?.trim() || env.OPENCLAW_CONTAINER?.trim() || null;
}
