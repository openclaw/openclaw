import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
  readBundledDiscoveryModeMemoized,
} from "./bundled-discovery-state.js";
import {
  prepareBundledDiscoveryModeNative,
  readBundledDiscoveryModeNative,
} from "./bundled-discovery-state.native.js";
import {
  createPluginCache,
  isPluginCacheFactInvalidatedError,
  PluginCacheFactInvalidatedError,
  withPluginCache,
} from "./plugin-cache.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";

const reads = vi.hoisted(() => ({
  artifact: vi.fn<() => boolean>(),
  snapshot: vi.fn<() => object | undefined>(),
  mode: vi.fn<() => unknown>(),
  asyncMode: vi.fn<() => Promise<unknown>>(),
  metadata: vi.fn(),
}));

vi.mock("../state/openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-readonly.js")>()),
  getActiveOpenClawStateDatabaseReadSnapshot: reads.snapshot,
  isArtifactPreservingStateRead: reads.artifact,
  executeExistingOpenClawStateRead: reads.metadata,
  withArtifactPreservingStateReads: <T>(read: () => T): T => read(),
}));
vi.mock("../state/config-machine-state.js", () => ({ readConfigMachineState: reads.mode }));
vi.mock("../state/config-machine-state-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/config-machine-state-async.js")>()),
  readConfigMachineStateAsync: reads.asyncMode,
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/plugin-admission" };

beforeEach(() => {
  vi.resetAllMocks();
  reads.artifact.mockReturnValue(true);
  reads.snapshot.mockReturnValue({});
  reads.mode.mockReturnValue("allowlist");
  reads.asyncMode.mockResolvedValue("allowlist");
  reads.metadata.mockResolvedValue({
    ok: true,
    type: "plugins.metadata.read",
    rows: [{ state_key: "plugins.bundledDiscovery", value_json: '"allowlist"' }],
  });
  clearBundledDiscoveryModeMemo();
});

afterEach(() => {
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
    name: "asynchronous discovery snapshot row",
    reject: reads.asyncMode,
    read: () => prepareBundledDiscoveryMode(env),
  },
  {
    name: "synchronous discovery row",
    reject: reads.mode,
    read: () => readBundledDiscoveryModeNative({ env }),
  },
  {
    name: "artifact-preserving memoized discovery row",
    reject: reads.mode,
    read: () => prepareBundledDiscoveryModeNative(env, { artifactPreservingReadOnly: true }),
  },
  {
    name: "memoized prepared row callback",
    reject: reads.mode,
    read: () => {
      reads.snapshot.mockReturnValue(undefined);
      return prepareBundledDiscoveryModeNative(env, {}, reads.mode);
    },
  },
  {
    name: "metadata adapter read operation",
    reject: reads.metadata,
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
  "retains typed invalidation and ordinary errors from $name",
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
    const failure = new Error("Synthetic metadata read failure");
    reject.mockImplementation(() => {
      throw failure;
    });
    await withPluginCache(createPluginCache(), async () => {
      await expect(Promise.resolve().then(async () => await read())).rejects.toBe(failure);
    });
  },
);

it("prepares snapshot policy asynchronously and reuses it for synchronous derivation", async () => {
  await withPluginCache(createPluginCache(), async () => {
    const activate = await prepareBundledDiscoveryMode(env);
    activate();
    expect(readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
    await prepareBundledDiscoveryMode(env);
    expect(reads.asyncMode).toHaveBeenCalledTimes(1);
    expect(reads.mode).not.toHaveBeenCalled();
  });
});

it("requires preparation for a cold snapshot without falling back to a native read", () => {
  expect(() => readBundledDiscoveryModeMemoized(env)).toThrow("not prepared");
  expect(reads.mode).not.toHaveBeenCalled();
  expect(reads.asyncMode).not.toHaveBeenCalled();
});

it("keeps explicit native preparation outside the runtime getter", () => {
  expect(prepareBundledDiscoveryModeNative(env)).toBe("allowlist");
  expect(readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
  expect(prepareBundledDiscoveryModeNative(env)).toBe("allowlist");
  expect(reads.mode).toHaveBeenCalledTimes(1);
  expect(reads.asyncMode).not.toHaveBeenCalled();
});

it("prepares an empty artifact root without publishing its policy to live readers", async () => {
  reads.snapshot.mockReturnValue(undefined);
  reads.asyncMode.mockResolvedValue(undefined);
  await withPluginCache(createPluginCache(), async () => {
    await prepareBundledDiscoveryMode(env);
    expect(readBundledDiscoveryModeMemoized(env)).toBeUndefined();
    reads.artifact.mockReturnValue(false);
    expect(() => readBundledDiscoveryModeMemoized(env)).toThrow("not prepared");
  });
  expect(reads.asyncMode).toHaveBeenCalledTimes(1);
  expect(reads.mode).not.toHaveBeenCalled();
});

it("keeps reactivation bound to the captured snapshot", async () => {
  const original = {};
  reads.snapshot.mockReturnValue(original);
  const activate = await prepareBundledDiscoveryMode(env);
  reads.snapshot.mockReturnValue({});

  activate();

  expect(() => readBundledDiscoveryModeMemoized(env)).toThrow("not prepared");
  reads.snapshot.mockReturnValue(original);
  expect(readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
  expect(reads.asyncMode).toHaveBeenCalledTimes(1);
});
