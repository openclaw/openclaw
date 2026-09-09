import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveGatewayService } from "../../daemon/service.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import {
  cancelUpdateRecoveryRestart,
  reconcileUpdateRecoveryStoppedSuppression,
  inspectUpdateRecoveryNativeManager,
  recordUpdateRecoveryNativeIntent,
  recordUpdateRecoveryNativeNotApplied,
  recordUpdateRecoveryNativeObservation,
  type UpdateRecoveryNativeFacts,
} from "../../infra/update-run-recovery-native.js";
import {
  assertExactUpdateRecoveryClaim,
  UpdateRecoveryConflictError,
} from "../../infra/update-run-recovery.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import { setUpdateCommandNativePolicy } from "./update-command-native-policy.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Retain the real executor/source owners through settling ambiguous dispatch,
 * suppression, stop and cancellation. No historical row grants native authority. */
export async function quiesceFailedUpdateCommand(params: {
  recovery: UpdateCommandRecovery;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const { recovery, env } = params;
  const initial = recovery.getRecord();
  if (
    !initial.primaryFailure ||
    !initial.checkpoint ||
    !initial.nativeManager ||
    initial.terminal
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Failed update quiescence lacks its live recovery binding.",
    );
  }
  await withUpdateCommandSourceOwnership({ recovery, env, mutation: true }, async (source) => {
    const { assertCurrent, verifySources, definitionPaths } = source;
    const fence = { assertCurrent };
    const observe = async () => {
      const expected = recovery.getRecord();
      await verifySources();
      assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
      const observed = await readUpdateCommandNativeObservation({
        record: expected,
        env,
        definitionPaths,
        inspectOwnedUnit: () => {
          assertCurrent();
          assertExactUpdateRecoveryClaim(expected, { assertCurrent }, recovery.options);
        },
        assertCurrent,
        timeoutMs: params.timeoutMs,
        quiescingFailedCandidate: true,
      });
      await verifySources();
      assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
      return observed;
    };
    const verify = async () => {
      const expected = recovery.getRecord();
      await verifySources();
      assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
    };
    await verify();
    let current = recovery.getRecord();
    const pending = current.nativeManager!.effects.at(-1);
    if (pending?.state === "intent") {
      let inspected = await inspectUpdateRecoveryNativeManager(
        current,
        observe,
        fence,
        recovery.options,
      );
      await verify();
      if (inspected.status !== "conflict") {
        // The failed supervisor can settle or retry after the preliminary read.
        // Resolve from the owner's latest complete observation, not the earlier
        // classification. A before/conflict result leaves the intent pending.
        inspected = await recordUpdateRecoveryNativeObservation(
          current,
          pending.effectId,
          observe,
          fence,
          recovery.options,
        );
        recovery.onRecord(inspected.record);
      }
      if (inspected.status === "before") {
        recovery.onRecord(
          await recordUpdateRecoveryNativeNotApplied(
            current,
            pending.effectId,
            observe,
            fence,
            recovery.options,
          ),
        );
      } else if (inspected.status === "conflict") {
        recovery.onRecord(
          await reconcileUpdateRecoveryStoppedSuppression(
            current,
            observe,
            fence,
            recovery.options,
          ),
        );
      }
    }
    const reconcileStopped = async () => {
      const expected = recovery.getRecord();
      const suppressed = expected.nativeManager!.effects.at(-1);
      if (
        suppressed?.action !== "suppress" ||
        suppressed.state !== "observed" ||
        suppressed.reconciledStop ||
        suppressed.after.stopped
      ) {
        return;
      }
      const actual = await observe();
      await verify();
      if (actual.facts.stopped) {
        recovery.onRecord(
          await reconcileUpdateRecoveryStoppedSuppression(
            expected,
            observe,
            fence,
            recovery.options,
          ),
        );
      }
    };
    await reconcileStopped();
    current = recovery.getRecord();
    const last = current.nativeManager!.effects.at(-1);
    const restart = current.effects.at(-1);
    if (
      last?.state === "not-applied" &&
      restart?.state === "intent" &&
      restart.kind === "service-restart" &&
      last.effectId === restart.effectId
    ) {
      recovery.onRecord(
        await cancelUpdateRecoveryRestart(current, observe, fence, recovery.options),
      );
    }
    const apply = async (
      action: "suppress" | "stop",
      target: UpdateRecoveryNativeFacts,
      dispatch: () => Promise<void>,
    ): Promise<void> => {
      await verify();
      const expected = recovery.getRecord();
      let intent: Awaited<ReturnType<typeof recordUpdateRecoveryNativeIntent>>;
      try {
        intent = await recordUpdateRecoveryNativeIntent(
          expected,
          { effectId: randomUUID(), action, target, observe },
          fence,
          recovery.options,
        );
      } catch (error) {
        // No effect was dispatched. Reconcile only an unchanged failed-start
        // row whose complete native read now proves spontaneous Linux drainage.
        // Other conflicts retain the original refusal; this cannot loop because
        // the stop edge removes the running-to-stopped discrepancy.
        if (
          !(error instanceof UpdateRecoveryConflictError) ||
          action !== "suppress" ||
          expected.nativeManager!.identity.platform !== "linux"
        ) {
          throw error;
        }
        assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
        const actual = await observe();
        assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
        const before = currentUpdateRecoveryNativeFacts(expected.nativeManager!);
        if (before.stopped || !isDeepStrictEqual(actual.facts, { ...before, stopped: true })) {
          throw error;
        }
        await apply("stop", actual.facts, () =>
          resolveGatewayService().stop({ env, stdout: params.stdout, assertCurrent }),
        );
        await apply(
          "suppress",
          {
            ...currentUpdateRecoveryNativeFacts(recovery.getRecord().nativeManager!),
            enabled: false,
          },
          dispatch,
        );
        return;
      }
      recovery.onRecord(intent.record);
      let failure: unknown;
      if (intent.status === "before") {
        try {
          assertCurrent();
          await dispatch();
        } catch (error) {
          failure = error;
        }
      }
      await verify();
      const observed = await recordUpdateRecoveryNativeObservation(
        intent.record,
        intent.record.nativeManager!.effects.at(-1)!.effectId,
        observe,
        fence,
        recovery.options,
      );
      recovery.onRecord(observed.record);
      if (observed.status === "conflict" && action === "suppress") {
        recovery.onRecord(
          await reconcileUpdateRecoveryStoppedSuppression(
            observed.record,
            observe,
            fence,
            recovery.options,
          ),
        );
      } else if (observed.status !== "after") {
        throw new UpdateCommandRecoveryPendingError(
          "Failed candidate remains pending native quiescence.",
          { cause: failure },
        );
      }
    };
    const manager = recovery.getRecord().nativeManager!;
    let facts = currentUpdateRecoveryNativeFacts(manager);
    if (!facts.exists) {
      throw new UpdateCommandRecoveryPendingError(
        "Captured native service disappeared before quiescence.",
      );
    }
    if (facts.enabled) {
      await apply("suppress", { ...facts, enabled: false }, () =>
        setUpdateCommandNativePolicy(manager.identity, false, env, assertCurrent, params.timeoutMs),
      );
    }
    await reconcileStopped();
    facts = currentUpdateRecoveryNativeFacts(recovery.getRecord().nativeManager!);
    await apply(
      "stop",
      {
        ...facts,
        stopped: true,
        loaded: manager.identity.platform === "darwin" ? false : facts.loaded,
      },
      () => resolveGatewayService().stop({ env, stdout: params.stdout, assertCurrent }),
    );
    current = recovery.getRecord();
    const final = await observe();
    await verify();
    if (
      !final.facts.stopped ||
      !isDeepStrictEqual(final.facts, currentUpdateRecoveryNativeFacts(current.nativeManager!))
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Failed candidate stop is not independently confirmed.",
      );
    }
    const incomplete = current.effects.at(-1);
    if (incomplete?.kind === "service-restart" && incomplete.state === "intent") {
      recovery.onRecord(
        await cancelUpdateRecoveryRestart(current, observe, fence, recovery.options),
      );
    }
  });
}
