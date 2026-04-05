export function resolveDaemonContainerContext(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.MULLUSI_CONTAINER_HINT?.trim() || env.MULLUSI_CONTAINER?.trim() || null;
}
