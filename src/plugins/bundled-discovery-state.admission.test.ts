import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
  readBundledDiscoveryMode,
  readBundledDiscoveryModeMemoized,
} from "./bundled-discovery-state.js";
import {
  createPluginCache,
  isPluginCacheFactInvalidatedError,
  PluginCacheFactInvalidatedError,
  withPluginCache,
} from "./plugin-cache.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";

const reads = vi.hoisted(() => ({
  snapshot: vi.fn<() => object | undefined>(),
  mode: vi.fn<() => unknown>(),
  row: vi.fn<() => { value_json: string } | undefined>(),
  worker: vi.fn(() => {
    throw new Error("This controlled admission test must not dispatch storage work");
  }),
}));

vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  getActiveOpenClawStateDatabaseReadSnapshot: reads.snapshot,
  isArtifactPreservingStateRead: () => true,
}));
vi.mock("../state/config-machine-state.js", () => ({ readConfigMachineState: reads.mode }));
vi.mock("./installed-plugin-index-row.js", () => ({
  readPluginMetadataStateRowSync: reads.row,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({ admission: { assertCurrent() {} } }),
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: reads.worker,
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/plugin-admission" };

beforeEach(() => {
  vi.resetAllMocks();
  reads.snapshot.mockReturnValue({});
  reads.mode.mockReturnValue("allowlist");
  reads.row.mockReturnValue({ value_json: '"allowlist"' });
  clearBundledDiscoveryModeMemo();
});

afterEach(() => {
  expect(reads.worker).not.toHaveBeenCalled();
  clearBundledDiscoveryModeMemo();
});

const readers = [
  {
    name: "direct preparation snapshot",
    reject: reads.snapshot,
    read: () => prepareBundledDiscoveryMode(env),
  },
  {
    name: "memoized discovery snapshot",
    reject: reads.snapshot,
    read: () => readBundledDiscoveryModeMemoized(env),
  },
  {
    name: "synchronous discovery row",
    reject: reads.mode,
    read: () => readBundledDiscoveryMode({ env }),
  },
  {
    name: "artifact-preserving memoized discovery row",
    reject: reads.mode,
    read: () => readBundledDiscoveryModeMemoized(env, { artifactPreservingReadOnly: true }),
  },
  {
    name: "memoized prepared row callback",
    reject: reads.mode,
    read: () => {
      reads.snapshot.mockReturnValue(undefined);
      return readBundledDiscoveryModeMemoized(env, {}, reads.mode);
    },
  },
  {
    name: "metadata adapter snapshot",
    reject: reads.snapshot,
    read: () => readPluginMetadataStateRow("bundled-discovery", { env }),
  },
  {
    name: "metadata adapter synchronous row",
    reject: reads.row,
    read: () => readPluginMetadataStateRow("bundled-discovery", { env }),
  },
];

function invalidatedRead() {
  // Error codes preserve the owner's identity across source/require module graphs.
  return Object.assign(new Error("Selected discovery read scope is closed"), {
    code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
  });
}

it.each(readers)(
  "retains typed invalidation and its cause from $name",
  async ({ reject, read }) => {
    const cause = invalidatedRead();
    reject.mockImplementation(() => {
      throw cause;
    });
    await withPluginCache(createPluginCache(), async () => {
      const result = Promise.resolve().then(async () => await read());
      await expect(result).rejects.toBeInstanceOf(PluginCacheFactInvalidatedError);
      await result.catch((error: unknown) =>
        expect(error instanceof Error && error.cause).toBe(cause),
      );
      await expect(result.catch(isPluginCacheFactInvalidatedError)).resolves.toBe(true);
    });
  },
);

it("retains typed invalidation when reactivating a prepared discovery snapshot", async () => {
  await withPluginCache(createPluginCache(), async () => {
    const activate = await prepareBundledDiscoveryMode(env);
    const cause = invalidatedRead();
    reads.snapshot.mockImplementation(() => {
      throw cause;
    });
    const result = Promise.resolve().then(activate);
    await expect(result).rejects.toBeInstanceOf(PluginCacheFactInvalidatedError);
    await result.catch((error: unknown) =>
      expect(error instanceof Error && error.cause).toBe(cause),
    );
  });
});

it.each(readers)("preserves ordinary errors from $name", async ({ reject, read }) => {
  const failure = new Error("Synthetic metadata read failure");
  reject.mockImplementation(() => {
    throw failure;
  });
  await withPluginCache(createPluginCache(), async () => {
    await expect(Promise.resolve().then(async () => await read())).rejects.toBe(failure);
  });
});
