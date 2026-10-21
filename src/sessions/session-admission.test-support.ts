import { afterEach, beforeEach } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { beginSessionEffect, runSessionMutation } from "./session-controller.lifecycle.js";

export function admissionGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

export const admitSession = (params: Parameters<typeof beginSessionEffect>[0]) =>
  beginSessionEffect({ assertAllowed: () => {}, ...params });

export function admissionTarget<T extends (string | undefined)[]>(scope: string, ...identities: T) {
  return { scope, identities };
}

/** Release blockers first, then settle every test-owned admission and mutation. */
export function installAdmissionFixtures() {
  let gates: ReturnType<typeof admissionGate>[];
  let admissions: ReturnType<typeof admitSession>[];
  let mutations: Promise<unknown>[];
  beforeEach(() => {
    gates = [];
    admissions = [];
    mutations = [];
  });
  afterEach(async () => {
    for (const barrier of gates) {
      barrier.release();
    }
    await Promise.all([
      ...admissions.map(async (pending) => (await pending.catch(() => undefined))?.release()),
      ...mutations.map((pending) => pending.catch(() => undefined)),
    ]);
  });
  return {
    track: <T>(pending: Promise<T>) => {
      mutations.push(pending);
      return pending;
    },
    gate: () => {
      const barrier = admissionGate();
      gates.push(barrier);
      return barrier;
    },
    admit: (params: Parameters<typeof admitSession>[0]) => {
      const pending = admitSession(params);
      admissions.push(pending);
      return pending;
    },
    mutate: <T>(params: Parameters<typeof runSessionMutation<T>>[0]) => {
      const pending = runSessionMutation(params);
      mutations.push(pending);
      return pending;
    },
  };
}
