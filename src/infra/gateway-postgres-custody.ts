import {
  acquireConfiguredGatewayPostgresOwner,
  type GatewayPostgresOwner,
} from "./gateway-postgres-owner.js";

/**
 * The PostgreSQL half of one Gateway lock. Each acquisition attempt of the process owner takes a
 * fresh loss signal; `acquire` takes the session lock at most once (also after a late engine
 * selection), and release ends it. Without a signal, as for a borrowed owner, acquire is a no-op.
 */
export function createGatewayPostgresCustody() {
  let owner: GatewayPostgresOwner | undefined;
  let custody: AbortController | undefined;
  return {
    signal(): AbortSignal {
      custody = new AbortController();
      return custody.signal;
    },
    async acquire(onContention: (target: string) => void = () => undefined): Promise<void> {
      const lost = custody;
      if (!owner && lost) {
        owner = await acquireConfiguredGatewayPostgresOwner({
          onContention,
          onLost: (error) => lost.abort(error),
        });
      }
    },
    async release(): Promise<void> {
      const held = owner;
      owner = undefined;
      custody = undefined;
      await held?.release();
    },
  };
}
