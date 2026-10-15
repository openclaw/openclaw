import { hasUnjoinedWork } from "../../../scripts/lib/managed-child-process.mts";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

export function createTestIngressQueue<TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
  stateDir: string,
  options: Omit<
    Parameters<typeof createChannelIngressQueue>[0],
    "channelId" | "accountId" | "stateDir"
  > = {},
) {
  return createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
    channelId: "test",
    accountId: "account",
    stateDir,
    ...options,
  });
}

export function useRetainedIngressState(
  registerCleanup: (cleanup: () => Promise<void>) => unknown,
) {
  let retainedState: OpenClawTestState | undefined;
  let retainedFailure: { error: unknown } | undefined;

  registerCleanup(async () => {
    if (retainedFailure) {
      throw retainedFailure.error;
    }
    try {
      await retainedState?.cleanup();
      retainedState = undefined;
    } catch (error) {
      retainedFailure = { error };
      throw error;
    }
  });

  return async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
    if (retainedFailure) {
      throw retainedFailure.error;
    }
    // The earlier cold/authority cases retain isolated fixtures and never enter this owner.
    const state = (retainedState ??= await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-ingress-queue-retained-",
      applyEnv: false,
    }));
    const failures = new Set<unknown>();
    const work = new AsyncWorkScope(failures);
    const [outcome] = await Promise.allSettled([work.track(() => fn(state.stateDir))]);
    await work.drain();
    if ([...failures].some(hasUnjoinedWork)) {
      try {
        await state.restoreEnv();
      } catch (error) {
        failures.add(error);
      }
      const retained = [...failures];
      const error =
        retained.length === 1
          ? retained[0]
          : new AggregateError(retained, `Fixture cleanup unverified; retained ${state.root}`);
      retainedFailure = { error };
      throw error;
    }
    try {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
      // Callback finally blocks have restored spies; native commands and their descendants settled.
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<ChannelIngressTestDatabase>(db).deleteFrom(
              "channel_ingress_events",
            ),
          ),
        { env: state.env },
      );
      return outcome.value;
    } catch (error) {
      try {
        await state.cleanup();
        retainedState = undefined;
      } catch (cleanupError) {
        const failure = new AggregateError(
          [error, cleanupError],
          `Fixture cleanup unverified; retained ${state.root}`,
          { cause: error },
        );
        retainedFailure = { error: failure };
        throw failure;
      }
      throw error;
    }
  };
}
