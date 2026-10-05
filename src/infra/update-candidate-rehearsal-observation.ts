import { createConfigIO } from "../config/io.factory.js";
import type { UpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import {
  projectUpdateCandidateStateObservation,
  type UpdateCandidateRehearsalStateObservation,
} from "./update-candidate-state-observation.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";
export type { UpdateCandidateRehearsalStateObservation } from "./update-candidate-state-observation.js";

/** Called only after all canary children settle and before their private files are cleaned up. */
export async function collectUpdateCandidateRehearsalStateObservation(params: {
  rehearsal: UpdateCandidateRehearsal;
  root: string;
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<UpdateCandidateRehearsalStateObservation> {
  const { rehearsal } = params;
  if (!rehearsal.databaseMappings || !rehearsal.sourceStateVersions) {
    throw new Error(
      "Candidate snapshot worker does not provide exact database observation mappings.",
    );
  }
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  const snapshot = await createConfigIO({
    configPath: rehearsal.configPath,
    env: rehearsal.env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  params.assertCurrent?.();
  if (!snapshot.valid) {
    throw new Error(
      "Post-rehearsal configuration cannot select verified private database observations.",
    );
  }
  const stateVersions = await readUpdateStateSchemaVersions({
    root: params.root,
    nodeRunner: params.nodeRunner,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    stateDir: rehearsal.stateDir,
    env: rehearsal.env,
    config: snapshot.config,
  });
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  return projectUpdateCandidateStateObservation(
    rehearsal.stateDir,
    rehearsal.databaseMappings,
    rehearsal.sourceStateVersions,
    stateVersions,
  );
}
