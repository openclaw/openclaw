import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  createEnvironmentComputerTransportOwner,
  createWorkerComputerTransportOwner,
  type PreparedWorkerComputer,
  type WorkerEnvironmentComputerAuthority,
} from "./computer-transport.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import type { WorkerComputerExecutor } from "./worker-turn-computer-rpc.js";

type WorkerComputerTransport = ReturnType<PreparedWorkerComputer["bind"]>;

/** Owns prepared computer lifetimes across conversation, worker-connection, and Gateway closure. */
export function createWorkerComputerService(
  options: Parameters<typeof createWorkerComputerTransportOwner>[0] & {
    placements: Pick<
      WorkerSessionPlacementStore,
      "get" | "validateTurnClaim" | "registerTurnClaimClosedHandler"
    >;
  },
) {
  const create = createWorkerComputerTransportOwner(options);
  const createAttached = createEnvironmentComputerTransportOwner(options);
  const attachedOwners = new Map<
    Promise<PreparedWorkerComputer | undefined>,
    WorkerEnvironmentComputerAuthority
  >();
  type Owner = {
    claimId: string;
    prepared: Promise<PreparedWorkerComputer | undefined>;
    transport?: WorkerComputerTransport;
    connection?: { signal: AbortSignal; abort: () => void };
    closeComputer?: PreparedWorkerComputer["close"];
    closing?: Promise<void>;
  };
  const owners = new Map<string, Owner>();
  const closeOwner = (owner: Owner, reason: string) => {
    if (owner.closing) {
      return owner.closing;
    }
    owner.transport = undefined;
    owner.connection?.signal.removeEventListener("abort", owner.connection.abort);
    // Fence this exact owner immediately, but retain cleanup custody until the
    // native ACK so concurrent claim closure or Gateway stop joins the same close.
    owner.closing = (async () => {
      try {
        await owner.prepared;
        await owner.closeComputer?.(reason);
      } finally {
        if (owners.get(owner.claimId) === owner) {
          owners.delete(owner.claimId);
        }
      }
    })();
    return owner.closing;
  };
  const unregister = options.placements.registerTurnClaimClosedHandler((claim) => {
    const owner = owners.get(claim.claimId);
    if (owner) {
      void closeOwner(owner, "turn-closed").catch(() =>
        options.warn("Session computer cleanup failed after turn closure."),
      );
    }
  });
  let stopped = false;
  return {
    prepareAttached: (authority: WorkerEnvironmentComputerAuthority) => {
      if (stopped) {
        return Promise.reject(new Error("Session computer owner closed"));
      }
      const prepared = createAttached({
        ...authority,
        assertCurrent: () => {
          if (stopped) {
            throw new Error("Session computer owner closed");
          }
          authority.assertCurrent();
        },
      }).then((computer) =>
        computer
          ? {
              ...computer,
              close: async (reason: string) => {
                await computer.close(reason);
                attachedOwners.delete(prepared);
              },
            }
          : undefined,
      );
      attachedOwners.set(prepared, authority);
      void prepared.then(
        (computer) => {
          if (!computer) {
            attachedOwners.delete(prepared);
          }
        },
        () => attachedOwners.delete(prepared),
      );
      return prepared;
    },
    closeEnvironment: async (environmentId: string, ownerEpoch?: number) => {
      const results = await Promise.allSettled(
        [...attachedOwners]
          .filter(
            ([, source]) =>
              source.environmentId === environmentId &&
              (ownerEpoch === undefined || source.ownerEpoch === ownerEpoch),
          )
          .map(async ([prepared]) =>
            (await prepared.catch(() => undefined))?.close("environment-stopped"),
          ),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Attached computer cleanup failed");
      }
    },
    prepare: (claim: WorkerSessionTurnClaim) => {
      if (stopped || !options.placements.validateTurnClaim(claim)) {
        return Promise.reject(new Error("Session computer owner closed"));
      }
      const prior = owners.get(claim.claimId);
      if (prior) {
        return prior.prepared;
      }
      const prepared = create(claim).then((computer) => {
        if (!computer) {
          return undefined;
        }
        owner.closeComputer = (reason) => computer.close(reason);
        const assertOwner = () => {
          if (stopped || owner.closing || owners.get(claim.claimId) !== owner) {
            throw new Error("Session computer owner replaced");
          }
        };
        return {
          ...computer,
          bind(run: OperationalRunInstanceRef) {
            assertOwner();
            const transport = computer.bind(run);
            const bound: WorkerComputerTransport = {
              computerUse: transport.computerUse,
              async resolveNode(query, signal) {
                assertOwner();
                const result = await transport.resolveNode(query, signal);
                assertOwner();
                return result;
              },
              async invoke(request, assertAuthorized) {
                assertOwner();
                const result = await transport.invoke(request, () => {
                  assertOwner();
                  assertAuthorized?.();
                });
                assertOwner();
                return result;
              },
            };
            owner.transport = bound;
            return bound;
          },
          close: (reason: string) => closeOwner(owner, reason),
        };
      });
      const owner: Owner = { claimId: claim.claimId, prepared };
      owners.set(claim.claimId, owner);
      return prepared;
    },
    execute: (async ({ identity, request, signal, assertCurrent }) => {
      assertCurrent();
      const claim = identity.turnClaim;
      const owner = claim ? owners.get(claim.claimId) : undefined;
      const computer = await owner?.prepared;
      assertCurrent();
      if (
        !computer ||
        !owner?.transport ||
        owner.closing ||
        owners.get(owner.claimId) !== owner ||
        !signal ||
        (owner.connection && owner.connection.signal !== signal)
      ) {
        throw new Error("Session computer connection is unavailable; start a new turn");
      }
      signal.throwIfAborted();
      if (!owner.connection) {
        // The worker socket owns input between requests too. Reconnects cannot
        // adopt this execution; Codex's local prepare/bind path has no socket owner.
        const abort = () => {
          void closeOwner(owner, "worker-disconnect").catch(() =>
            options.warn("Session computer cleanup failed after worker disconnect."),
          );
        };
        owner.connection = { signal, abort };
        signal.addEventListener("abort", abort, { once: true });
      }
      const result = await owner.transport.invoke(
        {
          nodeId: computer.descriptor.nodeId,
          command: request.command,
          commandParams: JSON.parse(request.paramsJson),
          timeoutMs: request.timeoutMs,
          idempotencyKey: request.idempotencyKey,
          signal,
        },
        assertCurrent,
      );
      assertCurrent();
      return { resultJson: JSON.stringify(result) };
    }) satisfies WorkerComputerExecutor,
    close: async () => {
      stopped = true;
      unregister();
      const results = await Promise.allSettled([
        ...[...owners.values()].map((owner) => closeOwner(owner, "gateway-stop")),
        ...[...attachedOwners.keys()].map(async (prepared) =>
          (await prepared.catch(() => undefined))?.close("gateway-stop"),
        ),
      ]);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Session computer cleanup failed",
        );
      }
    },
  };
}
