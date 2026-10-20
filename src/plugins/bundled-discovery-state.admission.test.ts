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
const memoized = () => readBundledDiscoveryModeMemoized(env);
const readers = [
  ["preparation snapshot", reads.snapshot, prepare],
  ["memoized snapshot", reads.snapshot, memoized],
  ["async snapshot row", reads.metadata, prepare],
  ["sync row", reads.mode, () => readBundledDiscoveryMode({ env })],
  [
    "artifact-preserving row",
    reads.mode,
    () => readBundledDiscoveryModeMemoized(env, { artifactPreservingReadOnly: true }),
  ],
  [
    "prepared row callback",
    reads.mode,
    () => {
      reads.snapshot.mockReturnValue(undefined);
      return readBundledDiscoveryModeMemoized(env, {}, reads.mode);
    },
  ],
  [
    "metadata adapter",
    reads.metadata,
    () => readPluginMetadataStateRow("bundled-discovery", { env }),
  ],
] as const;

it.each(readers)(
  "retains typed invalidation and ordinary errors from %s",
  async (_name, reject, read) => {
    // Codes preserve the owner's identity across source/require module graphs.
    const cause = Object.assign(new Error("Selected discovery read scope is closed"), {
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    });
    reject.mockImplementation(() => {
      throw cause;
    });
    await withPluginCache(createPluginCache(), async () => {
      const result = Promise.resolve().then(async () => await read());
      await expect(result).rejects.toBe(cause);
      await expect(result.catch(isStateDatabaseReadAdmissionInvalidatedError)).resolves.toBe(true);
    });
    const failure = new Error("Synthetic metadata read failure");
    reject.mockImplementation(() => {
      throw failure;
    });
    await withPluginCache(createPluginCache(), async () => {
      await expect(Promise.resolve().then(async () => await read())).rejects.toBe(failure);
    });
  },
);

it("waits for pending snapshot bytes without synchronously acquiring them", async () => {
  const snapshot = createDeferredCore<object>();
  reads.snapshotAsync.mockReturnValue(snapshot.promise);
  reads.snapshot.mockImplementation(() => {
    throw new Error("Pending snapshot bytes must be prepared asynchronously");
  });
  await withPluginCache(createPluginCache(), async () => {
    const preparing = prepareBundledDiscoveryMode(env);
    try {
      expect(reads.snapshot).not.toHaveBeenCalled();
      expect(reads.metadata).not.toHaveBeenCalled();
    } finally {
      snapshot.resolve({});
      await preparing;
    }
    expect(reads.metadata).toHaveBeenCalledOnce();
  });
});

it("prepares snapshot policy asynchronously and reuses it for synchronous derivation", async () => {
  await withPluginCache(createPluginCache(), async () => {
    const activate = await prepareBundledDiscoveryMode(env);
    activate();
    expect(readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
    await prepareBundledDiscoveryMode(env);
    expect(reads.metadata).toHaveBeenCalledTimes(1);
    expect(reads.mode).not.toHaveBeenCalled();
  });
});
