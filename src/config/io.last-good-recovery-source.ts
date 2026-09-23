import type fs from "node:fs";
import type { ConfigHealthFingerprint } from "./io.health-state.types.js";
import {
  createConfigBackupReadEffect,
  createConfigRecoveryStatEffect,
  type ConfigRecoveryEffect,
} from "./io.observe-recovery-effects.js";
import { createConfigHealthFingerprint } from "./io.observe-state.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import type {
  ConfigRecoveryCandidate,
  ConfigRecoveryCandidatePreparation,
  NormalizedConfigIoDeps,
  PrepareConfigRecoveryCandidate,
} from "./io.types.js";

type RecoverySourceDeps = Pick<NormalizedConfigIoDeps, "fs" | "json5">;

export function parseBackupConfigRaw(
  deps: RecoverySourceDeps,
  backupRaw: string,
): { parsed: unknown } | null {
  try {
    return { parsed: deps.json5.parse(backupRaw) };
  } catch {
    return null;
  }
}

// Reads a retained `.last-good` payload and accepts it as a recovery source
// only when its bytes still match the recorded accepted-baseline hash. Any
// mismatch (missing file, divergent bytes, unparsable JSON5, rejected
// candidate) returns null so the caller falls back to the explicit path
// instead of restoring unverified bytes.
export function* prepareLastGoodRecoverySource(params: {
  deps: RecoverySourceDeps;
  prepareBackup: PrepareConfigRecoveryCandidate;
  prepareBackupAsync?: (
    candidate: ConfigRecoveryCandidate,
  ) => Promise<ConfigRecoveryCandidatePreparation>;
  lastGoodPath: string;
  baselineHash: string;
}): Generator<
  ConfigRecoveryEffect<unknown>,
  {
    raw: string;
    candidate: ConfigRecoveryCandidate;
    fingerprint: ConfigHealthFingerprint;
    stat: fs.Stats | null;
  } | null,
  unknown
> {
  const { deps } = params;
  const lastGoodRaw = (yield createConfigBackupReadEffect(deps, params.lastGoodPath)) as
    | string
    | null;
  if (!lastGoodRaw || hashConfigRaw(lastGoodRaw) !== params.baselineHash) {
    return null;
  }
  const lastGoodParse = parseBackupConfigRaw(deps, lastGoodRaw);
  if (!lastGoodParse) {
    return null;
  }
  const lastGoodCandidate = { raw: lastGoodRaw, parsed: lastGoodParse.parsed };
  const prepared = (yield {
    sync: () => params.prepareBackup(lastGoodCandidate),
    async: () =>
      params.prepareBackupAsync?.(lastGoodCandidate) ?? params.prepareBackup(lastGoodCandidate),
  }) as ConfigRecoveryCandidatePreparation;
  if (!prepared.ok) {
    return null;
  }
  const lastGoodStat = (yield createConfigRecoveryStatEffect(
    deps,
    params.lastGoodPath,
  )) as fs.Stats | null;
  const fingerprint = createConfigHealthFingerprint({
    raw: lastGoodRaw,
    parsed: lastGoodParse.parsed,
    stat: lastGoodStat,
  });
  if (!fingerprint.gatewayMode) {
    return null;
  }
  return { raw: lastGoodRaw, candidate: prepared.candidate, fingerprint, stat: lastGoodStat };
}
