import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { withTempHome } from "../config/test-helpers.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { retireIdleOpenClawStateReadWorkers } from "../state/openclaw-state-read-worker.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";

type DoctorFixtureObservation = {
  id: number;
  suite: "billing-route" | "preflight";
  started: number;
  nextStep: number;
  pending: Map<number, string>;
  omittedPending: number;
  events: Array<{ phase: string; event: "started" | "settled"; elapsedMs: number }>;
  bodySettled: boolean;
  fixtureSettled: boolean;
  testFinished: boolean;
  ownsHome?: () => boolean;
};

const fixtureObservation = new AsyncLocalStorage<DoctorFixtureObservation>();
const activeObservations = new Set<DoctorFixtureObservation>();
let nextObservation = 0;

function recordFixturePhase(
  observation: DoctorFixtureObservation,
  phase: string,
  event: "started" | "settled",
) {
  observation.events.push({
    phase,
    event,
    elapsedMs: Math.round(performance.now() - observation.started),
  });
  if (observation.events.length > 16) {
    observation.events.shift();
  }
}

function reportFixtureObservation(observation: DoctorFixtureObservation, event: string) {
  const otherActive = [...activeObservations].filter((other) => other !== observation);
  process.stderr.write(
    `[doctor-fixture] ${JSON.stringify({
      suite: observation.suite,
      id: observation.id,
      event,
      elapsedMs: Math.round(performance.now() - observation.started),
      bodySettled: observation.bodySettled,
      fixtureSettled: observation.fixtureSettled,
      ownsHome: observation.ownsHome?.() ?? null,
      pending: [...observation.pending.values()],
      omittedPending: observation.omittedPending,
      otherActive: otherActive.slice(0, 8).map((other) => other.id),
      omittedActive: Math.max(0, otherActive.length - 8),
      phases: observation.events,
    })}\n`,
  );
}

/** Observe the original promise without supplying cancellation or changing its deadline. */
export async function observeDoctorConfigStep<T>(
  name: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const observation = fixtureObservation.getStore();
  if (!observation) {
    return await run();
  }
  const id = ++observation.nextStep;
  const tracked = observation.pending.size < 16;
  if (tracked) {
    observation.pending.set(id, name);
  } else {
    observation.omittedPending++;
  }
  recordFixturePhase(observation, name, "started");
  try {
    return await run();
  } finally {
    if (tracked) {
      observation.pending.delete(id);
    } else {
      observation.omittedPending--;
    }
    recordFixturePhase(observation, name, "settled");
  }
}

/** Retain inspection imports across repair and reread within each temporary home. */
export function useDoctorConfigPreflightHome(diagnostic?: DoctorFixtureObservation["suite"]) {
  return <T>(run: (home: string) => Promise<T>): Promise<T> => {
    if (!diagnostic) {
      return withDoctorConfigPreflightHome(run);
    }
    const observation: DoctorFixtureObservation = {
      id: ++nextObservation,
      suite: diagnostic,
      started: performance.now(),
      nextStep: 0,
      pending: new Map(),
      omittedPending: 0,
      events: [],
      bodySettled: false,
      fixtureSettled: false,
      testFinished: false,
    };
    activeObservations.add(observation);
    onTestFinished(({ task }) => {
      observation.testFinished = true;
      if (task.result?.state === "fail" || !observation.fixtureSettled) {
        reportFixtureObservation(observation, "test-finished");
      }
    });
    if (activeObservations.size > 1) {
      reportFixtureObservation(observation, "successor-started-before-settlement");
    }
    return fixtureObservation.run(observation, async () => {
      recordFixturePhase(observation, "fixture", "started");
      try {
        return await withDoctorConfigPreflightHome(async (home) => {
          observation.ownsHome = () => process.env.HOME === home;
          recordFixturePhase(observation, "body", "started");
          try {
            return await run(home);
          } finally {
            observation.bodySettled = true;
            recordFixturePhase(observation, "body", "settled");
          }
        });
      } finally {
        observation.fixtureSettled = true;
        recordFixturePhase(observation, "fixture", "settled");
        activeObservations.delete(observation);
        if (observation.testFinished) {
          reportFixtureObservation(observation, "late-fixture-settlement");
        }
      }
    });
  };
}

/** Keep real preflight fixtures from provisioning plugins for the developer's credentials. */
export async function withDoctorConfigPreflightHome<T>(
  run: (home: string) => Promise<T>,
): Promise<T> {
  return withTempHome(async (home) => {
    const control = path.join(home, "update-control");
    await fs.mkdir(control, { mode: 0o700 });
    const temporaryRoot = vi
      .spyOn(temporaryState, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(control);
    const providerEnv = Object.fromEntries(
      listKnownProviderAuthEnvVarNamesCore({ config: {}, env: process.env }).map((key) => [
        key,
        undefined,
      ]),
    );
    try {
      expect(resolveManagedUpdateLeaseDatabasePath()).toBe(
        path.join(control, "managed-update-handoffs.sqlite"),
      );
      const workers = createSqliteReadOnlyWorkerScope();
      const [outcome] = await Promise.allSettled([
        workers.run(() => withEnvAsync(providerEnv, () => run(home))),
      ]);
      if (outcome.status === "rejected" && hasUnjoinedWork(outcome.reason)) {
        throw outcome.reason;
      }
      try {
        try {
          await workers.run(() =>
            cleanupSessionStateForTest({ stateDir: path.join(home, ".openclaw"), rootPath: home }),
          );
        } finally {
          await workers.close();
        }
        // Rehearsals put the broker socket under this home; retire it before removal.
        const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
        expect(
          await retireIdleOpenClawStateReadWorkers(source),
          `Doctor fixture still owns state readers: ${home}`,
        ).toBe(true);
        expect(
          await source.retireIdleBroker(),
          `Doctor fixture still owns native workers: ${home}`,
        ).toBe(true);
      } catch (error) {
        if (outcome.status === "rejected") {
          throw new AggregateError(
            [outcome.reason, error],
            "Doctor fixture body and cleanup failed",
            { cause: error },
          );
        }
        throw error;
      }
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
      return outcome.value;
    } finally {
      temporaryRoot.mockRestore();
    }
  });
}
