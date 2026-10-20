import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { snapshotReaderSlot } from "./plugin-metadata-snapshot-readers.js";
import {
  getCurrentPluginMetadataSnapshotRequiredRuntime,
  listKnownProviderAuthEnvVarNamesRuntime,
  listOpenClawPluginManifestMetadataRuntime,
  loadPluginMetadataSnapshotRuntime,
} from "./plugin-metadata-snapshot-required.js";

const { loadNative } = vi.hoisted(() => ({ loadNative: vi.fn() }));
vi.mock("./native-module-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-module-require.js")>()),
  tryNativeRequireModule: loadNative,
}));

const readerKeys = [
  "getCurrentPluginMetadataSnapshot",
  "loadPluginMetadataSnapshot",
  "listOpenClawPluginManifestMetadata",
  "listKnownProviderAuthEnvVarNamesCore",
] as const;
let previousReaders: PropertyDescriptorMap;
function clearReaders() {
  for (const key of readerKeys) {
    delete snapshotReaderSlot[key];
  }
}
beforeEach(() => {
  previousReaders = Object.getOwnPropertyDescriptors(snapshotReaderSlot);
  clearReaders();
  loadNative.mockReset();
});
afterEach(() => {
  clearReaders();
  Object.defineProperties(snapshotReaderSlot, previousReaders);
});

const reads = [
  {
    name: "current snapshot",
    run: () => getCurrentPluginMetadataSnapshotRequiredRuntime({}),
  },
  { name: "snapshot load", run: () => loadPluginMetadataSnapshotRuntime({ config: {} }) },
  { name: "manifest metadata", run: () => listOpenClawPluginManifestMetadataRuntime() },
  { name: "provider env names", run: () => listKnownProviderAuthEnvVarNamesRuntime() },
];

function captureFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

it("keeps a registered missing-current result distinct from an unavailable runtime", () => {
  snapshotReaderSlot.getCurrentPluginMetadataSnapshot = () => undefined;
  expect(getCurrentPluginMetadataSnapshotRequiredRuntime({})).toBeUndefined();
  expect(loadNative).not.toHaveBeenCalled();
});

it.each(
  reads.flatMap(({ name, run }) => ["registered", "native"].map((owner) => ({ name, run, owner }))),
)("preserves the original $owner $name error", ({ run, owner }) => {
  const failure = new Error("metadata owner failed");
  const fail = () => {
    throw failure;
  };
  if (owner === "registered") {
    for (const key of readerKeys) {
      snapshotReaderSlot[key] = fail;
    }
  } else {
    loadNative.mockImplementation(fail);
  }
  expect(captureFailure(run)).toBe(failure);
  if (owner === "registered") {
    expect(loadNative).not.toHaveBeenCalled();
  }
});

it.each(reads)("refuses a second transformed metadata owner for $name", ({ run }) => {
  loadNative.mockReturnValue({ ok: false });
  expect(run).toThrow("Host plugin metadata runtime requires native loading");
});

it.each(["registered", "native"] as const)(
  "forwards policy inputs and results unchanged through the %s owner",
  (owner) => {
    const manifests = [{ pluginDir: "/fixture", manifest: { id: "fixture" }, origin: "global" }];
    const names = ["FIXTURE_API_KEY"];
    const readers = {
      listOpenClawPluginManifestMetadata: vi.fn(() => manifests),
      listKnownProviderAuthEnvVarNamesCore: vi.fn(() => names),
    };
    if (owner === "registered") {
      Object.assign(snapshotReaderSlot, readers);
    } else {
      loadNative.mockReturnValue({ ok: true, moduleExport: readers });
    }
    const env = { OPENCLAW_HOME: "/fixture" };
    const params = { env, config: {}, includeUntrustedWorkspacePlugins: false };
    expect(listOpenClawPluginManifestMetadataRuntime(env)).toBe(manifests);
    expect(listKnownProviderAuthEnvVarNamesRuntime(params)).toBe(names);
    expect(readers.listOpenClawPluginManifestMetadata).toHaveBeenCalledExactlyOnceWith(env);
    expect(readers.listKnownProviderAuthEnvVarNamesCore).toHaveBeenCalledExactlyOnceWith(params);
    expect(loadNative).toHaveBeenCalledTimes(owner === "registered" ? 0 : 2);
  },
);
