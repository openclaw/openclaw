import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { snapshotReaderSlot } from "./plugin-metadata-snapshot-readers.js";
import {
  getCurrentPluginMetadataSnapshotRequiredRuntime,
  listKnownProviderAuthEnvVarNamesRuntime,
  listOpenClawPluginManifestMetadataRuntime,
  loadPluginMetadataSnapshotRuntime,
  resolvePluginMetadataSnapshotRequiredRuntime,
} from "./plugin-metadata-snapshot-required.js";

const { loadNative } = vi.hoisted(() => ({ loadNative: vi.fn() }));
vi.mock("./native-module-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-module-require.js")>()),
  tryNativeRequireModule: loadNative,
}));

const reads = {
  getCurrentPluginMetadataSnapshot: () => getCurrentPluginMetadataSnapshotRequiredRuntime({}),
  loadPluginMetadataSnapshot: () => loadPluginMetadataSnapshotRuntime({ config: {} }),
  resolvePluginMetadataSnapshot: () => resolvePluginMetadataSnapshotRequiredRuntime({ config: {} }),
  listOpenClawPluginManifestMetadata: () => listOpenClawPluginManifestMetadataRuntime(),
  listKnownProviderAuthEnvVarNamesCore: () => listKnownProviderAuthEnvVarNamesRuntime(),
};
let previousReaders: PropertyDescriptorMap;
function clearReaders() {
  for (const key of Object.keys(reads)) {
    Reflect.deleteProperty(snapshotReaderSlot, key);
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

it("keeps a registered missing-current result distinct from an unavailable runtime", () => {
  snapshotReaderSlot.getCurrentPluginMetadataSnapshot = () => undefined;
  expect(getCurrentPluginMetadataSnapshotRequiredRuntime({})).toBeUndefined();
  expect(loadNative).not.toHaveBeenCalled();
});

it.each(
  Object.entries(reads).flatMap(([name, run]) =>
    ["registered", "native"].map((owner) => ({ name, run, owner })),
  ),
)("preserves the original $owner $name error", ({ run, owner }) => {
  const failure = new Error("metadata owner failed");
  const fail = () => {
    throw failure;
  };
  if (owner === "registered") {
    Object.assign(
      snapshotReaderSlot,
      Object.fromEntries(Object.keys(reads).map((key) => [key, fail])),
    );
  } else {
    loadNative.mockImplementation(fail);
  }
  const call = vi.fn(run);
  expect(call).toThrow();
  expect(call.mock.results[0]?.value).toBe(failure);
  if (owner === "registered") {
    expect(loadNative).not.toHaveBeenCalled();
  }
});

it.each(Object.entries(reads))(
  "refuses a second transformed metadata owner for %s",
  (_name, run) => {
    loadNative.mockReturnValue({ ok: false });
    expect(run).toThrow("Host plugin metadata runtime requires native loading");
  },
);

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
