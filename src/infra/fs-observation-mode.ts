/**
 * Native fs-safe observation currently binds directory pins only on Node/Linux.
 * This selects a caller default, not capability proof: fs-safe still verifies
 * trusted procfs and the admitted Root before registering any native watch.
 */
export function defaultFsObservationUsePolling(): boolean {
  return (
    process.platform !== "linux" ||
    process.release.name !== "node" ||
    Boolean(process.versions.bun) ||
    Boolean(process.versions.deno)
  );
}
