import { vi } from "vitest";
import * as sessionLifecycle from "./session-lifecycle-admission.js";

export function observeSessionWorkAdmissionDrain(
  afterDrain: (
    params: Parameters<typeof sessionLifecycle.startSessionWorkAdmissionInterruption>[0],
    released: boolean,
  ) => Promise<void> | void,
): () => void {
  const startInterruption = sessionLifecycle.startSessionWorkAdmissionInterruption;
  const waitForRelease = sessionLifecycle.waitForSessionWorkAdmissionRelease;
  const interruptions = new WeakMap<Promise<void>, Parameters<typeof startInterruption>[0]>();
  const start = vi
    .spyOn(sessionLifecycle, "startSessionWorkAdmissionInterruption")
    .mockImplementation((params) => {
      const interruption = startInterruption(params);
      interruptions.set(interruption.released, params);
      return interruption;
    });
  const wait = vi
    .spyOn(sessionLifecycle, "waitForSessionWorkAdmissionRelease")
    .mockImplementation(async (pending, timeoutMs) => {
      const released = await waitForRelease(pending, timeoutMs);
      const params = interruptions.get(pending);
      if (params) {
        interruptions.delete(pending);
        // Fixture pauses follow the real drain, outside its production deadline.
        await afterDrain(params, released);
      }
      return released;
    });
  return () => {
    wait.mockRestore();
    start.mockRestore();
  };
}

type RunExclusiveSessionLifecycleParams<T> = {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
};

type SessionLifecycleAdmissionTestApi = {
  runExclusiveSessionLifecycle<T>(params: RunExclusiveSessionLifecycleParams<T>): Promise<T>;
};

function getTestApi(): SessionLifecycleAdmissionTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionLifecycleAdmissionTestApi")
  ] as SessionLifecycleAdmissionTestApi;
}

export async function runExclusiveSessionLifecycle<T>(
  params: RunExclusiveSessionLifecycleParams<T>,
): Promise<T> {
  return await getTestApi().runExclusiveSessionLifecycle(params);
}
