import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type LifecycleWriteCustodyPhase = "migration" | "backup" | "coordinator-write";

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.lifecycleWriteCustody"),
  () => new Map<LifecycleWriteCustodyPhase, { count: number }>(),
);

/**
 * Records an existing owner's lifetime; this observation grants no write authority.
 * Pass the original failure when settling. Uncertain command cleanup retains custody:
 * only this handle may release it after independent proof that owned work stopped.
 * Without that proof, the fact remains for this process's lifetime, not a timeout.
 */
export function beginLifecycleWriteCustody(
  phase: LifecycleWriteCustodyPhase,
): (failure?: unknown) => void {
  const owner = owners.get(phase) ?? { count: 0 };
  owner.count++;
  owners.set(phase, owner);
  let released = false;
  return (failure) => {
    if (released || hasCommandProcessCleanupError(failure)) {
      return;
    }
    released = true;
    if (--owner.count === 0) {
      owners.delete(phase);
    }
  };
}

export function readLifecycleWriteCustody(): Array<{
  phase: LifecycleWriteCustodyPhase;
  count: number;
}> {
  return [...owners]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([phase, { count }]) => ({ phase, count }));
}
