import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotReaderSlot } from "./plugin-metadata-snapshot-readers.js";
import { getCurrentPluginMetadataSnapshotRequiredRuntime } from "./plugin-metadata-snapshot-required.js";

const { loadNative } = vi.hoisted(() => ({ loadNative: vi.fn() }));
vi.mock("./native-module-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-module-require.js")>()),
  tryNativeRequireModule: loadNative,
}));

const readerKeys = ["getCurrentPluginMetadataSnapshot"] as const;
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

  it("preserves the original registered current snapshot error", () => {
    const failure = new Error("registered metadata owner failed");
    const fail = () => {
      throw failure;
    };
    snapshotReaderSlot.getCurrentPluginMetadataSnapshot = fail;
    expect(captureFailure(() => getCurrentPluginMetadataSnapshotRequiredRuntime({}))).toBe(failure);
    expect(loadNative).not.toHaveBeenCalled();
  });

  it("propagates the required native-loader error for current snapshots", () => {
    const failure = new Error("required metadata module failed to load");
    loadNative.mockImplementation(() => {
      throw failure;
    });
    expect(captureFailure(() => getCurrentPluginMetadataSnapshotRequiredRuntime({}))).toBe(failure);
  });

  it("refuses a second transformed current metadata owner", () => {
    loadNative.mockReturnValue({ ok: false });
    expect(() => getCurrentPluginMetadataSnapshotRequiredRuntime({})).toThrow(
      "Host plugin metadata runtime requires native loading",
    );
  });
});
