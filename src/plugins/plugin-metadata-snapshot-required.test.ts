import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotReaderSlot } from "./plugin-metadata-snapshot-readers.js";
import {
  getCurrentPluginMetadataSnapshotRequiredRuntime,
  loadPluginMetadataSnapshotRuntime,
} from "./plugin-metadata-snapshot-required.js";

const { loadNative } = vi.hoisted(() => ({ loadNative: vi.fn() }));
vi.mock("./native-module-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-module-require.js")>()),
  tryNativeRequireModule: loadNative,
}));

const readerKeys = ["getCurrentPluginMetadataSnapshot", "loadPluginMetadataSnapshot"] as const;
let previousReaders: PropertyDescriptorMap;
beforeEach(() => {
  previousReaders = Object.getOwnPropertyDescriptors(snapshotReaderSlot);
  for (const key of readerKeys) {
    delete snapshotReaderSlot[key];
  }
  loadNative.mockReset();
});
afterEach(() => {
  for (const key of readerKeys) {
    const descriptor = previousReaders[key];
    if (descriptor) {
      Object.defineProperty(snapshotReaderSlot, key, descriptor);
    } else {
      delete snapshotReaderSlot[key];
    }
  }
});

const reads = [
  {
    name: "current snapshot",
    run: () => getCurrentPluginMetadataSnapshotRequiredRuntime({}),
  },
  { name: "snapshot load", run: () => loadPluginMetadataSnapshotRuntime({ config: {} }) },
];

function captureFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("required plugin metadata readers", () => {
  it("keeps a registered missing-current result distinct from an unavailable runtime", () => {
    snapshotReaderSlot.getCurrentPluginMetadataSnapshot = () => undefined;
    expect(getCurrentPluginMetadataSnapshotRequiredRuntime({})).toBeUndefined();
    expect(loadNative).not.toHaveBeenCalled();
  });

  it.each(reads)("preserves the original registered $name error", ({ run }) => {
    const failure = new Error("registered metadata owner failed");
    const fail = () => {
      throw failure;
    };
    snapshotReaderSlot.getCurrentPluginMetadataSnapshot = fail;
    snapshotReaderSlot.loadPluginMetadataSnapshot = fail;
    expect(captureFailure(run)).toBe(failure);
    expect(loadNative).not.toHaveBeenCalled();
  });

  it.each(reads)("propagates the required native-loader error for $name", ({ run }) => {
    const failure = new Error("required metadata module failed to load");
    loadNative.mockImplementation(() => {
      throw failure;
    });
    expect(captureFailure(run)).toBe(failure);
  });

  it.each(reads)("refuses a second transformed metadata owner for $name", ({ run }) => {
    loadNative.mockReturnValue({ ok: false });
    expect(run).toThrow("Host plugin metadata runtime requires native loading");
  });
});
