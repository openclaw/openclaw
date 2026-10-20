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

class DoctorFixtureObservation {
  readonly started = performance.now();
  nextStep = 0;
  readonly pending = new Map<number, string>();
  omittedPending = 0;
  readonly events: Array<{ phase: string; event: "started" | "settled"; elapsedMs: number }> = [];
  bodySettled = false;
  fixtureSettled = false;
  testFinished = false;
  ownsHome?: () => boolean;
  constructor(
    readonly id: number,
    readonly suite: "billing-route" | "preflight",
  ) {}
  record(phase: string, event: "started" | "settled") {
    this.events.push({ phase, event, elapsedMs: Math.round(performance.now() - this.started) });
    if (this.events.length > 16) {
      this.events.shift();
    }
  }
  report(event: string) {
    const otherActive = [...activeObservations].filter((other) => other !== this);
    const { suite, id, bodySettled, fixtureSettled, omittedPending, events: phases } = this;
    process.stderr.write(
      `[doctor-fixture] ${JSON.stringify({
        suite,
        id,
        event,
        elapsedMs: Math.round(performance.now() - this.started),
        bodySettled,
        fixtureSettled,
        ownsHome: this.ownsHome?.() ?? null,
        pending: [...this.pending.values()],
        omittedPending,
        otherActive: otherActive.slice(0, 8).map((other) => other.id),
        omittedActive: Math.max(0, otherActive.length - 8),
        phases,
      })}\n`,
    );
  }
  async during<T>(
    phase: string,
    run: () => T | Promise<T>,
    lifetime?: "bodySettled" | "fixtureSettled",
  ): Promise<T> {
    const id = lifetime ? 0 : ++this.nextStep;
    const tracked = !lifetime && this.pending.size < 16;
    if (tracked) {
      this.pending.set(id, phase);
    } else if (!lifetime) {
      this.omittedPending++;
    }
    this.record(phase, "started");
    try {
      return await run();
    } finally {
      if (lifetime) {
        this[lifetime] = true;
      } else if (tracked) {
        this.pending.delete(id);
      } else {
        this.omittedPending--;
      }
      this.record(phase, "settled");
    }
  }
}

const fixtureObservation = new AsyncLocalStorage<DoctorFixtureObservation>();
const activeObservations = new Set<DoctorFixtureObservation>();
let nextObservation = 0;

/** Observe the original promise without supplying cancellation or changing its deadline. */
export async function observeDoctorConfigStep<T>(
  name: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const observation = fixtureObservation.getStore();
  return observation ? await observation.during(name, run) : await run();
}

/** Retain inspection imports across repair and reread within each temporary home. */
export function useDoctorConfigPreflightHome(diagnostic?: DoctorFixtureObservation["suite"]) {
  return <T>(run: (home: string) => Promise<T>): Promise<T> => {
    if (!diagnostic) {
      return withDoctorConfigPreflightHome(run);
    }
    const observation = new DoctorFixtureObservation(++nextObservation, diagnostic);
    activeObservations.add(observation);
    onTestFinished(({ task }) => {
      observation.testFinished = true;
      if (task.result?.state === "fail" || !observation.fixtureSettled) {
        observation.report("test-finished");
      }
    });
    if (activeObservations.size > 1) {
      observation.report("successor-started-before-settlement");
    }
    return fixtureObservation.run(observation, async () => {
      try {
        return await observation.during(
          "fixture",
          () =>
            withDoctorConfigPreflightHome((home) => {
              observation.ownsHome = () => process.env.HOME === home;
              return observation.during("body", () => run(home), "bodySettled");
            }),
          "fixtureSettled",
        );
      } finally {
        activeObservations.delete(observation);
        if (observation.testFinished) {
          observation.report("late-fixture-settlement");
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
        await workers
          .run(() =>
            cleanupSessionStateForTest({ stateDir: path.join(home, ".openclaw"), rootPath: home }),
          )
          .finally(() => workers.close());
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
