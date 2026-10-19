import { afterAll, beforeAll, beforeEach } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import type { PairedDevice } from "./device-pairing.js";

export function usePairingState(prefix: string) {
  const dirs = createSuiteTempRootTracker({ prefix });
  const paths = new Set<string>();
  const state: { baseDir: string; env: NodeJS.ProcessEnv } = { baseDir: "", env: {} };
  beforeAll(() => dirs.setup());
  beforeEach(async () => {
    state.baseDir = await dirs.make();
    state.env = { ...process.env, OPENCLAW_STATE_DIR: state.baseDir };
    paths.add(resolveOpenClawStateSqlitePath(state.env));
  });
  afterAll(async () => {
    for (const databasePath of paths) {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
    await dirs.cleanup();
  });
  return state;
}

export const pairingTimestamps = { createdAtMs: 1, approvedAtMs: 1 };

export function legacyNodeDevice(
  deviceId: string,
  extra: Partial<PairedDevice> = {},
): PairedDevice {
  return {
    deviceId,
    publicKey: `pk-${deviceId}`,
    role: "node",
    roles: ["node"],
    tokens: { node: { token: `legacy-${deviceId}`, role: "node", scopes: [], createdAtMs: 1 } },
    approvedVia: "owner",
    ...pairingTimestamps,
    ...extra,
  };
}
