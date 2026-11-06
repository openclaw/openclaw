/** Canonical opt-in for OpenClaw ID runtime and presentation boundaries. */
export function isOpenClawIdEnabled(config: { enabled?: boolean } | undefined): boolean {
  return config?.enabled === true;
}
