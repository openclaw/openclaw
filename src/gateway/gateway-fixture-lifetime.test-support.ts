import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { GatewayStartupCleanupError } from "./server-shutdown.js";
import type { GatewayServer } from "./server.js";

type GatewayFixtureState =
  | { phase: "open" | "closing" | "closed" }
  | { phase: "retained"; error: unknown };
type GatewayFixtureOwner = {
  state: GatewayFixtureState;
  acquisition: Promise<void>;
  close?: GatewayServer["close"];
  closing?: Promise<void>;
};

// Module reset and another Gateway's normal close must not erase retained owners.
// This singleton deliberately has no production lifecycle reset callback.
const registry = resolveGlobalSingleton(Symbol.for("openclaw.gatewayFixtureLifetime"), () => ({
  active: new Set<GatewayFixtureOwner>(),
  owners: new WeakMap<GatewayServer, GatewayFixtureOwner>(),
}));

function closingOwner(): GatewayFixtureOwner | undefined {
  return [...registry.active].find((owner) => owner.state.phase !== "open");
}

function ownershipError(owner: GatewayFixtureOwner): Error {
  return new Error(
    `Gateway test fixture is ${owner.state.phase}; its close must complete before replacing or releasing test state`,
    { cause: owner.state.phase === "retained" ? owner.state.error : undefined },
  );
}

export const gatewayFixtureLifetime = {
  canAdmit(): boolean {
    return !closingOwner();
  },

  assertAdmission(): void {
    const owner = closingOwner();
    if (owner) {
      throw ownershipError(owner);
    }
  },

  assertReleased(): void {
    const owner = registry.active.values().next().value;
    if (owner) {
      throw ownershipError(owner);
    }
  },

  hasActiveServers(): boolean {
    return registry.active.size > 0;
  },

  canReleaseState(server: GatewayServer): boolean {
    // Selectors remain shared even when this exact server has already closed.
    return registry.owners.get(server)?.state.phase === "closed" && !closingOwner();
  },

  async settlePendingWork(): Promise<void> {
    await Promise.allSettled([...registry.active].map((owner) => owner.acquisition));
    await Promise.allSettled(
      [...registry.active].flatMap((owner) => (owner.closing ? [owner.closing] : [])),
    );
    this.assertAdmission();
  },

  async closeAll(): Promise<void> {
    await this.settlePendingWork();
    await Promise.allSettled(
      [...registry.active].flatMap((owner) => (owner.close ? [owner.close()] : [])),
    );
    this.assertReleased();
  },

  async ownServer(start: () => Promise<GatewayServer>, ownerRoot?: string): Promise<GatewayServer> {
    const acquired = createDeferredCore();
    const owner: GatewayFixtureOwner = {
      state: { phase: "open" },
      acquisition: acquired.promise,
    };
    const lifetime = createFixtureLifetime(ownerRoot);
    const closed = createDeferredCore();
    // Startup owns state before it can yield or fail without returning a close handle.
    registry.active.add(owner);
    try {
      void lifetime.track(closed.promise, true);
    } catch (error) {
      owner.state = { phase: "retained", error };
      acquired.resolve();
      throw error;
    }

    let server: GatewayServer;
    try {
      server = await start();
    } catch (error) {
      owner.state = { phase: "closing" };
      // Only the native cleanup outcome can certify a failed acquisition as released.
      if (error instanceof GatewayStartupCleanupError) {
        closed.reject(error);
      } else {
        closed.resolve();
      }
      try {
        await lifetime.cleanup();
        owner.state = { phase: "closed" };
        registry.active.delete(owner);
      } catch (cleanupError) {
        owner.state = { phase: "retained", error: cleanupError };
      }
      acquired.resolve();
      throw error;
    }
    const originalClose = server.close.bind(server);
    registry.owners.set(server, owner);
    let closePromise: Promise<void> | undefined;
    server.close = (...args: Parameters<GatewayServer["close"]>) => {
      if (closePromise) {
        return closePromise;
      }
      const result = createDeferredCore();
      closePromise = result.promise;
      owner.closing = closePromise;
      owner.state = { phase: "closing" };
      // Invoke the native close synchronously, after publishing the shared promise.
      const closing = (async () => {
        try {
          await originalClose(...args);
        } catch (error) {
          closed.reject(error);
          // The join records native retention; callers keep the original close error.
          await lifetime.cleanup().catch(() => {});
          throw error;
        }
        closed.resolve();
        await lifetime.cleanup();
      })();
      void closing.then(
        () => {
          owner.state = { phase: "closed" };
          registry.active.delete(owner);
          result.resolve();
        },
        (error: unknown) => {
          owner.state = { phase: "retained", error };
          result.reject(error);
        },
      );
      return closePromise;
    };
    owner.close = server.close;
    acquired.resolve();
    return server;
  },
};
