import { getEnvironmentData, setEnvironmentData, threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const key = "openclaw.nativeWorkerAncestors";

export function readWorkerAncestors(value: unknown): readonly number[] | undefined {
  return Array.isArray(value) &&
    value.every((id) => typeof id === "number" && Number.isInteger(id) && id >= 0)
    ? value
    : undefined;
}

/** Native ancestry follows Worker construction, never the logical caller of a retained supervisor. */
export const workerAncestors = resolveGlobalSingleton(Symbol.for(key), () => {
  const inherited: unknown = getEnvironmentData(key);
  const ancestors = inherited === undefined ? [] : readWorkerAncestors(inherited);
  if (!ancestors) {
    throw new Error("Native worker ancestry is invalid");
  }
  setEnvironmentData(key, [...ancestors, threadId]);
  return ancestors;
});
