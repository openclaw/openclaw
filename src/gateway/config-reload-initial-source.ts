import { hashConfigRaw } from "../config/io.read-helpers.js";
import type { createConfigSource } from "../config/source.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { diffConfigPaths } from "./config-diff.js";

export async function reconcileInitialConfigSource(params: {
  source: ReturnType<typeof createConfigSource>;
  isCurrent: () => boolean;
  getAcceptedSource: () => { rawHash: string | null; config: OpenClawConfig };
  initialIncludedPaths?: readonly string[];
  log: { warn: (message: string) => void };
}): Promise<void> {
  const { source, isCurrent } = params;
  const observed = source.observation;
  try {
    const snapshot = await source.readSnapshot(observed);
    if (!isCurrent() || source.observation !== observed) {
      return;
    }
    const accepted = params.getAcceptedSource();
    const includedPaths = snapshot.includedPaths ?? [];
    const initialPaths = params.initialIncludedPaths ?? [];
    const sameRoot = snapshot.exists
      ? hashConfigRaw(snapshot.raw) === accepted.rawHash
      : accepted.rawHash === null;
    if (
      snapshot.valid &&
      sameRoot &&
      initialPaths.length === includedPaths.length &&
      initialPaths.every((path) => includedPaths.includes(path)) &&
      (includedPaths.length === 0 ||
        diffConfigPaths(accepted.config, snapshot.sourceConfig).length === 0)
    ) {
      return;
    }
  } catch (error) {
    if (!isCurrent() || source.observation !== observed) {
      return;
    }
    params.log.warn(`config reload initial watch check failed: ${String(error)}`);
  }
  source.observe();
}
