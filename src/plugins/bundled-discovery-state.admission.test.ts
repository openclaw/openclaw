import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
  readBundledDiscoveryMode,
  readBundledDiscoveryModeMemoized,
} from "./bundled-discovery-state.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";

const reads = vi.hoisted(() => ({
  snapshot: vi.fn<() => object | undefined>(),
  snapshotAsync: vi.fn<() => Promise<object | undefined>>(),
  mode: vi.fn<() => unknown>(),
  metadata: vi.fn(),
}));

vi.mock("../state/openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-readonly.js")>()),
  getActiveOpenClawStateDatabaseReadSnapshot: reads.snapshot,
  getActiveOpenClawStateDatabaseReadSnapshotAsync: reads.snapshotAsync,
  isArtifactPreservingStateRead: () => true,
  executeExistingOpenClawStateRead: reads.metadata,
  withArtifactPreservingStateReads: <T>(read: () => T): T => read(),
}));
vi.mock("../state/config-machine-state.js", () => ({ readConfigMachineState: reads.mode }));

const env = { OPENCLAW_STATE_DIR: "/synthetic/plugin-admission" };
const inCache = <T>(run: () => T) => withPluginCache(createPluginCache(), run);

beforeEach(() => {
  vi.resetAllMocks();
  reads.snapshot.mockReturnValue({});
  reads.snapshotAsync.mockImplementation(async () => reads.snapshot());
  reads.mode.mockReturnValue("allowlist");
  reads.metadata.mockResolvedValue({
    ok: true,
    type: "plugins.metadata.read",
    rows: [{ state_key: "plugins.bundledDiscovery", value_json: '"allowlist"' }],
  });
  clearBundledDiscoveryModeMemo();
});

afterEach(clearBundledDiscoveryModeMemo);

const prepare = () => prepareBundledDiscoveryMode(env);
const artifactRow = () =>
  readBundledDiscoveryModeMemoized(env, { artifactPreservingReadOnly: true });
const metadataRow = () => readPluginMetadataStateRow("bundled-discovery", { env });
const preparedRow = () => {
  reads.snapshot.mockReturnValue(undefined);
  return readBundledDiscoveryModeMemoized(env, {}, reads.mode);
};
const readers = [
  ["preparation snapshot", reads.snapshot, prepare],
  ["memoized snapshot", reads.snapshot, () => readBundledDiscoveryModeMemoized(env)],
  ["async snapshot row", reads.metadata, prepare],
  ["sync row", reads.mode, () => readBundledDiscoveryMode({ env })],
  ["artifact-preserving row", reads.mode, artifactRow],
  ["prepared row callback", reads.mode, preparedRow],
  ["metadata adapter", reads.metadata, metadataRow],
] as const;

it.each(readers)("preserves invalidation and ordinary errors: %s", async (_name, reject, read) => {
  // Codes preserve the owner's identity across source/require module graphs.
  const cause = Object.assign(new Error("Selected discovery read scope is closed"), {
    code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
  });
  for (const failure of [cause, new Error("Synthetic metadata read failure")]) {
    reject.mockImplementation(() => {
      throw failure;
    });
    await inCache(async () => {
      const result = Promise.resolve().then(async () => {
        await read();
      });
      await expect(result).rejects.toBe(failure);
      const invalidated = await result.catch(isStateDatabaseReadAdmissionInvalidatedError);
      expect(invalidated).toBe(failure === cause);
    });
  }
});

it("waits for pending snapshot bytes without synchronously acquiring them", () =>
  inCache(async () => {
    const snapshot = createDeferredCore<object>();
    reads.snapshotAsync.mockReturnValue(snapshot.promise);
    reads.snapshot.mockImplementation(() => {
      throw new Error("Pending snapshot bytes must be prepared asynchronously");
    });
    const preparing = prepareBundledDiscoveryMode(env);
    try {
      expect(reads.snapshot).not.toHaveBeenCalled();
      expect(reads.metadata).not.toHaveBeenCalled();
    } finally {
      snapshot.resolve({});
      await preparing;
    }
    expect(reads.metadata).toHaveBeenCalledOnce();
  }));

it("prepares snapshot policy asynchronously and reuses it for synchronous derivation", () =>
  inCache(async () => {
    const activate = await prepareBundledDiscoveryMode(env);
    activate();
    expect(readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
    await prepareBundledDiscoveryMode(env);
    expect(reads.metadata).toHaveBeenCalledTimes(1);
    expect(reads.mode).not.toHaveBeenCalled();
  }));
