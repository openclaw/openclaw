import { runWithLocalStateOwner } from "./local-state-owner.js";

// Planning and inspection can also migrate config or reconcile Claw provenance.
export function offlineClawAction<Args extends unknown[]>(
  command: string,
  action: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return (...args) =>
    runWithLocalStateOwner({
      method: `claws.${command}`,
      params: {},
      target: "Claw configuration and provenance",
      onForeignOwner: "refuse",
      runLocal: () => action(...args),
    });
}
