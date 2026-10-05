import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";
import type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";

export type WorkerGitHubCredential = {
  token: string;
  expiresAtMs?: number;
};

const log = createSubsystemLogger("gateway/worker-github");

/** Credential cleanup cannot erase work already accepted by its execution owner. */
export async function revokeWorkerGitHubBindingGrant(
  grant: WorkerGitHubBindingGrant | undefined,
): Promise<void> {
  try {
    await grant?.revoke();
  } catch {
    log.warn(
      "Worker GitHub cleanup failed; accepted work still reconciles and final cleanup can retry.",
    );
  }
}

/** Execution owns its copy and delivery; the selected identity owner retains account authorization. */
export function createWorkerGitHubBindingGrant(params: {
  binding: WorkerGitHubLaunchBinding;
  credential: WorkerGitHubCredential;
  controller: AbortController;
  signal: AbortSignal;
  assertCurrent: () => void;
  refreshCredential: () => Promise<WorkerGitHubCredential | undefined>;
  refreshRequired?: () => boolean;
  subscribe: (changed: () => void) => (() => void)[];
  release?: () => void;
}): WorkerGitHubBindingGrant {
  let current = params.credential;
  let binding = params.binding;
  let pending:
    | { credential: WorkerGitHubCredential; refresh: WorkerGitHubBindingRefresh }
    | undefined;
  let generation = 0;
  let checkedAtMs = Date.now();
  let revoked = false;
  let refreshing: Promise<WorkerGitHubBindingRefresh | undefined> | undefined;
  let revocation: Promise<void> | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let deliveryWork: Promise<void> | undefined;
  let install: ((snapshot: WorkerGitHubBindingRefresh) => Promise<void>) | undefined;
  let renewalStopped = false;
  const stops: (() => void)[] = [];
  const assertCurrent = () => {
    try {
      params.signal.throwIfAborted();
      if (revoked) {
        throw new Error("Worker GitHub credential authority closed");
      }
      params.assertCurrent();
    } catch (error) {
      params.controller.abort(error);
      throw error;
    }
  };
  const revoke = (): Promise<void> => {
    if (!revocation) {
      revoked = true;
      clearTimeout(renewalTimer);
      params.signal.removeEventListener("abort", onAbort);
      stops.splice(0).forEach((stop) => stop());
      params.controller.abort(new Error("Worker GitHub credential authority closed"));
      revocation = Promise.resolve()
        .then(async () => {
          await refreshing?.catch(() => undefined);
          await deliveryWork?.catch(() => undefined);
          pending = undefined;
          params.release?.();
        })
        .finally(() => {
          revocation = undefined;
        });
    }
    return revocation;
  };
  const onAbort = () => {
    void revoke();
  };
  const refresh = (installedGeneration?: number) => {
    refreshing ??= (async () => {
      assertCurrent();
      if (pending?.refresh.expiresAtMs !== undefined && pending.refresh.expiresAtMs <= Date.now()) {
        pending = undefined;
        assertCurrent();
      }
      if (pending && installedGeneration === pending.refresh.generation) {
        current = pending.credential;
        binding = { ...binding, token: pending.refresh.token };
        pending = undefined;
        assertCurrent();
      }
      if (pending) {
        return pending.refresh;
      }
      if (Date.now() - checkedAtMs < 60_000 && !params.refreshRequired?.()) {
        return undefined;
      }
      const next = await params.refreshCredential();
      checkedAtMs = Date.now();
      if (!next) {
        return undefined;
      }
      assertCurrent();
      if (next.token === current.token && next.expiresAtMs === current.expiresAtMs) {
        return undefined;
      }
      pending = {
        credential: next,
        refresh: { generation: ++generation, token: next.token, expiresAtMs: next.expiresAtMs },
      };
      return pending.refresh;
    })()
      .catch(() => {
        assertCurrent();
        log.warn(
          "Worker GitHub renewal failed; retrying while its credential authority is current.",
        );
        return undefined;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
  const schedule = (delayMs: number) => {
    clearTimeout(renewalTimer);
    renewalTimer = setTimeout(() => {
      deliveryWork = (async () => {
        const consumer = install;
        if (!consumer) {
          return;
        }
        let snapshot = await refresh();
        while (snapshot) {
          assertCurrent();
          await consumer(snapshot);
          assertCurrent();
          snapshot = await refresh(snapshot.generation);
        }
      })()
        .catch(() => {
          if (!revoked && !params.signal.aborted) {
            log.warn(
              "Worker GitHub profile delivery failed; retrying while its authority is current.",
            );
          }
        })
        .finally(() => {
          deliveryWork = undefined;
          if (!revoked && !renewalStopped && !params.signal.aborted) {
            schedule(60_000);
          }
        });
    }, delayMs);
    renewalTimer.unref?.();
  };
  const changed = () => {
    if (!revoked) {
      try {
        assertCurrent();
        if (install && !renewalStopped && !deliveryWork && params.refreshRequired?.()) {
          schedule(1);
        }
      } catch {
        // The closed signal owns cleanup.
      }
    }
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  stops.push(...params.subscribe(changed));
  assertCurrent();
  return {
    get binding() {
      return binding;
    },
    get expiresAtMs() {
      return current.expiresAtMs;
    },
    signal: params.signal,
    assertCurrent,
    refresh,
    startRenewal(consumer) {
      assertCurrent();
      if (install) {
        throw new Error("Worker GitHub grant already has a renewal consumer");
      }
      install = consumer;
      // Rotation while node approval is pending must reach the first attached consumer.
      schedule(params.refreshRequired?.() ? 1 : 60_000);
      return () => {
        renewalStopped = true;
        clearTimeout(renewalTimer);
      };
    },
    revoke,
  };
}
