import { resolveGlobalSingleton } from "../shared/global-singleton.js";
const activeProjections = resolveGlobalSingleton(
  Symbol.for("openclaw.activeSessionRowProjections"),
  () => new WeakSet<object>(),
);
/** Liveness only; source and destination permissions remain with their own guards. */
export function isSessionRowProjectionActive(projection: object): boolean {
  return activeProjections.has(projection);
}

/** Installed before exposure; retirement precedes the same canonical disposer. */
export function activateSessionRowProjection<T extends { dispose(): void }>(projection: T): T {
  const dispose = projection.dispose.bind(projection);
  projection.dispose = () => {
    activeProjections.delete(projection);
    dispose();
  };
  activeProjections.add(projection);
  return projection;
}
