import { isDeepStrictEqual } from "node:util";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { capturePackageReverseAuthority } from "./package-update-activation-reverse.js";
import type { preparePackageActivation } from "./package-update-activation.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";

type Activation = NonNullable<Awaited<ReturnType<typeof preparePackageActivation>>>;
type Publication = NonNullable<PackageUpdateTransaction["reversePublication"]>;

/** Extend the native transaction without substituting its existing rollback,
 * retention or retirement policy. Issued reverse work belongs to this lifetime. */
export function withPackageReverseTransaction(
  transaction: PackageUpdateTransaction,
  activation: Activation | undefined,
): PackageUpdateTransaction {
  if (!activation) {
    return transaction;
  }
  const assertCurrent = activation.assertReverseCurrent.bind(activation);
  const assertLegacyRollback = activation.assertLegacyRollback.bind(activation);
  const read = activation.journal.read.bind(activation.journal);
  const publish = activation.reverse.bind(activation);
  const prepare = activation.prepareReverse.bind(activation);
  const settle = activation.settleReverse.bind(activation);
  const resources = activation.resourceCustody.bind(activation);
  const verify = activation.verifyCompletion.bind(activation);
  const commitCompletion = activation.commitCompletion.bind(activation);
  let reverse: ReturnType<Publication["publish"]> | undefined;
  let settlement: ReturnType<Publication["settle"]> | undefined;
  let settled = false;
  let closing = false;
  let completionDelegated = false;
  let rollbackStarted = false;
  const assertOpen = () => {
    assertCurrent();
    if (closing || rollbackStarted) {
      throw new Error("Package transaction settlement or rollback has started.");
    }
  };
  const join = async () => {
    const results = await Promise.allSettled([reverse, settlement]);
    const errors = [
      ...new Set(results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []))),
    ];
    const uncertain = errors.findIndex(hasCommandProcessCleanupError);
    if (uncertain !== -1) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "Reverse command cleanup is unconfirmed.", {
            cause: errors[uncertain],
          });
    }
    return errors.length > 0;
  };
  const retention = (message: string) => ({
    name: "package-backup-retention",
    command: "retain reverse publication",
    cwd: activation.anchor,
    durationMs: 0,
    exitCode: 1,
    stdoutTail: null,
    stderrTail: message,
  });
  return {
    ...transaction,
    reversePublication: {
      selection: () => {
        assertOpen();
        const { operationId, originalRunId, previous, previousRuntime } = read().descriptor;
        return structuredClone({
          anchor: activation.anchor,
          operationId,
          originalRunId,
          previous,
          previousRuntime,
        });
      },
      resourceCustody: async (authority) => {
        const assertInspectable = () => {
          assertOpen();
          if (reverse) {
            throw new Error("Resource custody requires the original pre-reverse lifetime.");
          }
        };
        assertInspectable();
        const custody = await resources(authority);
        assertInspectable();
        return Object.freeze({
          packageResources: custody.packageResources,
          stagingParent: (live: string) => {
            assertInspectable();
            return custody.stagingParent(live);
          },
        });
      },
      publish: (binding, authority) => {
        assertOpen();
        if (reverse) {
          throw new Error("Package reverse publication has already started.");
        }
        const before = read();
        reverse = publish(binding, authority).catch((error: unknown) => {
          try {
            assertCurrent();
            if (
              !hasCommandProcessCleanupError(error) &&
              before.phase === "publication-complete" &&
              !before.descriptor.reverse &&
              isDeepStrictEqual(before, read())
            ) {
              // Only a proved refusal before pinning may reopen first admission.
              reverse = undefined;
              settlement = undefined;
              settled = false;
            }
          } catch {
            /* A committed, revoked or uncertain effect remains latched. */
          }
          throw error;
        });
        return reverse;
      },
      prepare: (preparation, authority) => {
        assertOpen();
        if (reverse) {
          throw new Error("Package reverse publication has already started.");
        }
        const before = read();
        const preparing = prepare(preparation, authority).catch((error: unknown) => {
          try {
            assertCurrent();
            if (
              !hasCommandProcessCleanupError(error) &&
              before.phase === "publication-complete" &&
              !before.descriptor.reverse &&
              !before.descriptor.reversePreparation &&
              isDeepStrictEqual(before, read())
            ) {
              reverse = undefined;
              settlement = undefined;
              settled = false;
            }
          } catch {
            /* Durable preparation, revocation, or uncertain effects remain latched. */
          }
          throw error;
        });
        reverse = preparing.then((result) => result.status);
        return preparing;
      },
      settle: (authority) => {
        assertOpen();
        if (!reverse) {
          throw new Error("Package reverse publication is absent.");
        }
        const issued = reverse;
        if (settlement) {
          return settlement;
        }
        const guard = capturePackageReverseAuthority(authority);
        settlement = (async () => {
          await issued;
          const result = await settle(guard);
          settled = true;
          return result;
        })();
        return settlement;
      },
      verifyCompletion: async (binding, authority) => {
        assertOpen();
        if (!settled) {
          throw new Error("Reverse completion requires exhaustive settlement.");
        }
        const result = await verify(binding, authority);
        assertOpen();
        return result;
      },
      commitCompletion: async (binding, authority) => {
        assertOpen();
        if (!settled) {
          throw new Error("Reverse completion requires exhaustive settlement.");
        }
        const result = await commitCompletion(binding, authority);
        assertOpen();
        return result;
      },
    },
    rollback: async (assertion) => {
      if (!reverse && !settlement) {
        // A refused legacy transition has made no effect and must not close
        // this transaction's still-valid native reverse publication capability.
        assertLegacyRollback();
        rollbackStarted = true;
        return transaction.rollback(assertion);
      }
      rollbackStarted = true;
      closing = true;
      return (async () => {
        // Join even after revocation: authority loss cannot cancel issued effects.
        await join();
        assertCurrent();
        assertion();
        return {
          ...retention("Bound reverse publication requires its own recovery and settlement."),
          name: "package-rollback",
          activePackageRoot: null,
        };
      })();
    },
    complete: async (outcome, assertion) => {
      closing = true;
      const started = Boolean(reverse || settlement);
      const failed = await join();
      // The native transaction keeps its executor/caller guards and caches
      // retirement. A retired activation journal cannot be re-admitted here.
      if (!started || completionDelegated) {
        return transaction.complete(outcome, assertion);
      }
      assertCurrent();
      assertion();
      if (started && (failed || !settled)) {
        return retention(
          "Reverse publication is unverified; retain its original recovery evidence.",
        );
      }
      completionDelegated = true;
      return transaction.complete(outcome, assertion);
    },
  };
}
