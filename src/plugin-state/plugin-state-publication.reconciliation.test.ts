import { randomUUID } from "node:crypto";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../infra/errors.js";
import { readGlobalSingleton } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertPluginStatePublicationPreserves,
  assertPluginStatePublicationSettled,
  beginPluginStatePublication,
  isPluginStatePublicationUnavailable,
  pluginStatePublication,
  reconcilePluginStatePublication,
} from "./plugin-state-publication.js";
import {
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import { confirmPluginStateCommittedInWorker } from "./plugin-state-worker-client.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

const unavailable = "Plugin state authority is unavailable";
const scope = { pluginId: "reconcile-test", namespace: "leases", key: "lease" };

function settleUnknown(identity: string) {
  beginPluginStatePublication(() => identity, undefined, scope).finish("unknown");
}

function latchedIdentity() {
  const identity = `reconcile:${randomUUID()}`;
  settleUnknown(identity);
  return identity;
}

describe("plugin state unknown settlement reconciliation", () => {
  it("formats denial with the reconciliation singleton shape from an older module", async () => {
    const shared = readGlobalSingleton(Symbol.for("openclaw.pluginStatePublicationReconciliation"));
    assert(shared && typeof shared === "object", "Expected the shared reconciliation owner");
    const descriptor = Object.getOwnPropertyDescriptor(shared, "diagnosticKey");
    // An already loaded base module supplies epochs/active, but no diagnostic key.
    Reflect.deleteProperty(shared, "diagnosticKey");
    const identity = latchedIdentity();
    try {
      expect(() => assertPluginStatePublicationSettled(identity, scope)).toThrow(
        "reason=identity-unavailable-after-unknown",
      );
    } finally {
      if (descriptor) {
        Object.defineProperty(shared, "diagnosticKey", descriptor);
      }
      await reconcilePluginStatePublication(identity, async () => {});
    }
  });

  it.each(["pending", "unknown"] as const)(
    "formats %s denial without private data",
    async (kind) => {
      const identity = `file:/private/diagnostic-canary/database.sqlite:${randomUUID()}`;
      const privateScope = {
        pluginId: "private-plugin-canary",
        namespace: "private-namespace-canary",
        key: "private-session-canary",
      };
      const pending = beginPluginStatePublication(() => identity, undefined, privateScope);
      const failures: string[] = [];
      const readFailure = (assertCurrent: () => void) => {
        let failure: unknown;
        try {
          assertCurrent();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        const text = formatErrorMessage(failure);
        failures.push(text);
        return text;
      };
      try {
        if (kind === "unknown") {
          pending.finish("unknown");
        }
        for (const assertCurrent of [
          () => assertPluginStatePublicationSettled(identity, privateScope),
          () => assertPluginStatePublicationPreserves(identity, privateScope, () => {}),
        ]) {
          const text = readFailure(assertCurrent);
          expect(text).toContain(
            `reason=${kind === "unknown" ? "identity-unavailable-after-unknown" : "overlapping-publication-pending"}`,
          );
          expect(text).toContain(
            `settlement=${kind}; committed=unconfirmed; installation=${kind === "unknown" ? "invalidated" : "unconfirmed"}`,
          );
          expect(text).toContain(
            kind === "unknown"
              ? "Wait for committed-state confirmation before continuing."
              : "Wait for the pending publication to settle before continuing.",
          );
          expect(text).toContain("Do not replay the write while its outcome is uncertain.");
        }
        const references = failures.map((text) => /identityRef=([a-f0-9]{16})/.exec(text)?.[1]);
        expect(references[0]).toMatch(/^[a-f0-9]{16}$/);
        expect(new Set(references).size).toBe(1);
        expect(failures.join(" ")).not.toMatch(
          /diagnostic-canary|private-.*-canary|database.sqlite/,
        );
      } finally {
        pending.finish("completed");
        await reconcilePluginStatePublication(identity, async () => {});
      }
    },
  );

  it("latches the identity after an unknown settlement", () => {
    const identity = `reconcile:${randomUUID()}`;
    expect(() => assertPluginStatePublicationSettled(identity, scope)).not.toThrow();
    settleUnknown(identity);

    expect(isPluginStatePublicationUnavailable(identity)).toBe(true);
    // The latch is identity-wide, not limited to the uncertain write's scope.
    expect(() => assertPluginStatePublicationSettled(identity)).toThrow(unavailable);
    expect(() =>
      assertPluginStatePublicationSettled(identity, { ...scope, namespace: "other" }),
    ).toThrow(unavailable);
    expect(() => assertPluginStatePublicationPreserves(identity, scope, () => {})).toThrow(
      unavailable,
    );
  });

  it("clears the latch once committed state is re-read and confirmed", async () => {
    const identity = latchedIdentity();
    const confirm = vi.fn(async () => {});

    await expect(reconcilePluginStatePublication(identity, confirm)).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledOnce();
    expect(isPluginStatePublicationUnavailable(identity)).toBe(false);
    expect(() => assertPluginStatePublicationSettled(identity, scope)).not.toThrow();
    expect(() => assertPluginStatePublicationPreserves(identity, scope, () => {})).not.toThrow();
    // A recovered identity latches again on its next indeterminate outcome.
    settleUnknown(identity);
    expect(() => assertPluginStatePublicationSettled(identity, scope)).toThrow(unavailable);
  });

  it("does not confirm an identity that was never latched", async () => {
    const confirm = vi.fn(async () => {});
    await expect(
      reconcilePluginStatePublication(`reconcile:${randomUUID()}`, confirm),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("stays latched when committed state cannot be confirmed", async () => {
    const identity = latchedIdentity();

    await expect(
      reconcilePluginStatePublication(identity, async () => {
        throw new Error("worker lost");
      }),
    ).resolves.toBe(false);

    expect(() => assertPluginStatePublicationSettled(identity, scope)).toThrow(unavailable);
  });

  it("stays latched when another unknown outcome races the confirmation", async () => {
    const identity = latchedIdentity();
    let confirmed!: () => void;
    const reconciling = reconcilePluginStatePublication(
      identity,
      () =>
        new Promise<void>((resolve) => {
          confirmed = resolve;
        }),
    );
    // A second indeterminate write is unresolved by the read that was already in flight.
    settleUnknown(identity);
    confirmed();

    await expect(reconciling).resolves.toBe(false);
    expect(() => assertPluginStatePublicationSettled(identity, scope)).toThrow(unavailable);

    // A confirmation that starts after the conflict re-validates both outcomes.
    await expect(reconcilePluginStatePublication(identity, async () => {})).resolves.toBe(true);
    expect(() => assertPluginStatePublicationSettled(identity, scope)).not.toThrow();
  });

  it("shares one confirmation across concurrent callers", async () => {
    const identity = latchedIdentity();
    let confirmed!: () => void;
    const confirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          confirmed = resolve;
        }),
    );

    const first = reconcilePluginStatePublication(identity, confirm);
    const second = reconcilePluginStatePublication(identity, confirm);
    confirmed();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("keeps overlapping pending writes denied after recovery", async () => {
    const identity = latchedIdentity();
    await expect(reconcilePluginStatePublication(identity, async () => {})).resolves.toBe(true);

    const pending = beginPluginStatePublication(() => identity, undefined, scope);
    expect(() => assertPluginStatePublicationSettled(identity, scope)).toThrow(unavailable);
    pending.finish("completed");
    expect(() => assertPluginStatePublicationSettled(identity, scope)).not.toThrow();
  });

  it("restores authority from a committed worker read after an undelivered receipt", async () => {
    await withOpenClawTestState({ label: "plugin-state-reconcile" }, async ({ env }) => {
      const native = createPluginStateSyncKeyedStore("receipt-test", {
        namespace: "receipts",
        maxEntries: 10,
        env,
      });
      native.register("lease", true);
      const context = captureOpenClawStateWorkerContext({ env });
      const identity = context.admission.identity.key;
      const receiptScope = { pluginId: "receipt-test", namespace: "receipts" };
      const stopFault = pluginStatePublication.subscribeFacts((change) => {
        if (change.kind === "committed") {
          throw new Error("fact sink unavailable");
        }
      });
      try {
        native.delete("lease");
      } catch {
        // The commit landed; only its facts were not delivered.
      } finally {
        stopFault();
      }
      expect(() => assertPluginStatePublicationSettled(identity, receiptScope)).toThrow(
        unavailable,
      );

      await expect(
        reconcilePluginStatePublication(identity, () =>
          confirmPluginStateCommittedInWorker(context, receiptScope),
        ),
      ).resolves.toBe(true);

      expect(() => assertPluginStatePublicationSettled(identity, receiptScope)).not.toThrow();
      expect(native.lookup("lease")).toBeUndefined();
    });
  });
});
