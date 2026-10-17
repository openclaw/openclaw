import {
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

export function withState(label: string, run: Parameters<typeof withOpenClawTestState>[1]) {
  return withOpenClawTestState({ label, layout: "home" }, run);
}

export function runRepair(
  cfg: OpenClawConfig,
  {
    candidate = structuredClone(cfg),
    ...options
  }: Omit<Parameters<typeof runDoctorRepairSequence>[0], "state" | "doctorFixCommand"> & {
    candidate?: OpenClawConfig;
  } = {},
) {
  return runDoctorRepairSequence({
    state: { cfg, candidate, pendingChanges: false, fixHints: [] },
    doctorFixCommand: "openclaw doctor --fix",
    ...options,
  });
}

export function apiKey<K>(provider: string, key: K) {
  return { type: "api_key" as const, provider, key };
}

export function authStore<P>(
  profiles: P,
  state: Omit<AuthProfileStore, "version" | "profiles"> = {},
) {
  return { version: 1, profiles, ...state };
}

export function writeStore(env: NodeJS.ProcessEnv, store: unknown, agentDir?: string) {
  runAuthProfileWriteTransaction(
    agentDir,
    (database) => {
      writePersistedAuthProfileStoreRaw(store, agentDir, database);
    },
    { env },
  );
}
