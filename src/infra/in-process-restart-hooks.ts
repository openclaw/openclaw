/**
 * Process-global registry of subsystem cleanup hooks invoked at the gateway
 * in-process restart boundary (SIGUSR1 / OPENCLAW_NO_RESPAWN reload).
 *
 * Most subsystem state is recreated per gateway lifecycle, but a few helpers
 * (notably the Telegram polling lease registry) live on `process[Symbol.for(...)]`
 * so they survive across in-process restarts. When the previous lifecycle's
 * task is dropped before its `finally` releases the resource, the next
 * lifecycle observes a stale entry and rejects all work for that subsystem
 * (#81507). The fix is for those subsystems to register a lifecycle reset
 * hook here; the gateway run-loop drains them at the same boundary that
 * already resets command lanes and restart-deferral state.
 *
 * Hooks must be:
 *  - synchronous and side-effect-only (no I/O, no awaiting), so the boundary
 *    stays cheap and predictable;
 *  - safe to call repeatedly (idempotent), so process-respawn paths and
 *    test harnesses can invoke them without coordinating ordering;
 *  - safe to throw \u2014 errors from one hook never block sibling hooks.
 *
 * Hooks are stored on a `Symbol.for()`-keyed registry on `process`, matching
 * the storage style used by the subsystems they clean up. A second module
 * load (e.g. ESM/CJS interop boundaries) reuses the same Set instead of
 * creating a duplicate.
 */

const HOOKS_KEY = Symbol.for("openclaw.inProcessRestartHooks.v1");

type ResetHook = () => void;

type RegistryHost = NodeJS.Process & {
  [HOOKS_KEY]?: Set<ResetHook>;
};

function getRegistry(): Set<ResetHook> {
  const host = process as RegistryHost;
  host[HOOKS_KEY] ??= new Set<ResetHook>();
  return host[HOOKS_KEY];
}

/**
 * Register a lifecycle reset hook. Returns an unregister function; calling
 * it more than once is safe.
 */
export function registerInProcessRestartHook(hook: ResetHook): () => void {
  const registry = getRegistry();
  registry.add(hook);
  let unregistered = false;
  return () => {
    if (unregistered) {
      return;
    }
    unregistered = true;
    registry.delete(hook);
  };
}

/**
 * Run every registered hook, swallowing per-hook errors so a single failing
 * subsystem cannot block the rest. Returns the number of hooks invoked.
 */
export function runInProcessRestartHooks(): number {
  const registry = getRegistry();
  if (registry.size === 0) {
    return 0;
  }
  // Snapshot to allow hooks to safely register/unregister others.
  const snapshot = Array.from(registry);
  for (const hook of snapshot) {
    try {
      hook();
    } catch {
      // Hooks must be best-effort; swallow to keep the restart boundary
      // moving. Subsystems that need to surface failures should log inside
      // the hook itself.
    }
  }
  return snapshot.length;
}

/** Test-only helper: drop every registered hook. */
export function clearInProcessRestartHooksForTests(): void {
  getRegistry().clear();
}
