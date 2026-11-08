import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readUpdateCandidatePluginAssets,
  UPDATE_PLUGIN_ASSET_RECEIPT_ENV,
} from "../infra/update-candidate-plugin-assets.js";
import { createPrivateAssetFixture } from "./plugin-source-capture-asset.test-support.js";
import {
  getPluginSourceCaptureStorage,
  resolvePluginSourceCaptureStorage,
  withPluginSourceCaptureStorage,
} from "./plugin-source-capture-context.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function selectedAssets() {
  const storage = resolvePluginSourceCaptureStorage();
  return readUpdateCandidatePluginAssets(storage.stateDir, storage.privateAssetReceipt);
}

it.each(["same", "different"])(
  "does not use a valid ambient %s-state receipt when explicit authority is absent",
  async (ambientState) => {
    const selected = await createPrivateAssetFixture(dirs.make("selected-private-assets-"));
    const ambient =
      ambientState === "same"
        ? selected
        : await createPrivateAssetFixture(dirs.make("ambient-private-assets-"));
    vi.stubEnv(UPDATE_PLUGIN_ASSET_RECEIPT_ENV, ambient.receipt);
    withPluginSourceCaptureStorage(
      { stateDir: selected.stateDir, placement: "temporary", privateAssetReceipt: undefined },
      () => {
        expect(getPluginSourceCaptureStorage()?.privateAssetReceipt).toBeUndefined();
        expect(resolvePluginSourceCaptureStorage().privateAssetReceipt).toBeUndefined();
        expect(selectedAssets()).toEqual([]);
        expect(
          resolvePluginSourceCaptureStorage(selected.stateDir).privateAssetReceipt,
        ).toBeUndefined();
        withPluginSourceCaptureStorage(
          { stateDir: selected.stateDir, placement: "temporary" },
          () => expect(selectedAssets()).toEqual([]),
        );
      },
    );
  },
);

it("selects an explicit receipt over ambient authority and inherits it when omitted", async () => {
  const selected = await createPrivateAssetFixture(dirs.make("selected-private-assets-"));
  const ambient = await createPrivateAssetFixture(dirs.make("ambient-private-assets-"));
  vi.stubEnv(UPDATE_PLUGIN_ASSET_RECEIPT_ENV, ambient.receipt);
  withPluginSourceCaptureStorage(
    { stateDir: selected.stateDir, placement: "temporary", privateAssetReceipt: selected.receipt },
    () => {
      expect(selectedAssets()).toEqual([selected.edge]);
      withPluginSourceCaptureStorage({ stateDir: selected.stateDir, placement: "temporary" }, () =>
        expect(selectedAssets()).toEqual([selected.edge]),
      );
      withPluginSourceCaptureStorage(
        { stateDir: selected.stateDir, placement: "temporary", privateAssetReceipt: undefined },
        () => expect(selectedAssets()).toEqual([]),
      );
      expect(selectedAssets()).toEqual([selected.edge]);
    },
  );
});

it("preserves default Gateway process authority without an explicit selection", async () => {
  const selected = await createPrivateAssetFixture(dirs.make("gateway-private-assets-"));
  vi.stubEnv(UPDATE_PLUGIN_ASSET_RECEIPT_ENV, selected.receipt);
  expect(getPluginSourceCaptureStorage()).toBeUndefined();
  expect(resolvePluginSourceCaptureStorage(selected.stateDir).privateAssetReceipt).toBe(
    selected.receipt,
  );
  withPluginSourceCaptureStorage({ stateDir: selected.stateDir, placement: "temporary" }, () => {
    expect(selectedAssets()).toEqual([selected.edge]);
  });
});

it("keeps an inherited absent receipt absent after ambient authority appears", async () => {
  const selected = await createPrivateAssetFixture(dirs.make("late-ambient-private-assets-"));
  vi.stubEnv(UPDATE_PLUGIN_ASSET_RECEIPT_ENV, undefined);
  withPluginSourceCaptureStorage({ stateDir: selected.stateDir, placement: "temporary" }, () => {
    vi.stubEnv(UPDATE_PLUGIN_ASSET_RECEIPT_ENV, selected.receipt);
    expect(selectedAssets()).toEqual([]);
  });
});

it("uses the resolver selector to distinguish explicit absence from omission", async () => {
  const selected = await createPrivateAssetFixture(dirs.make("selector-private-assets-"));
  vi.stubEnv(UPDATE_PLUGIN_ASSET_RECEIPT_ENV, selected.receipt);
  expect(
    resolvePluginSourceCaptureStorage(selected.stateDir, "temporary", { value: undefined })
      .privateAssetReceipt,
  ).toBeUndefined();
  expect(
    resolvePluginSourceCaptureStorage(selected.stateDir, "temporary", { value: selected.receipt })
      .privateAssetReceipt,
  ).toBe(selected.receipt);
  expect(
    resolvePluginSourceCaptureStorage(selected.stateDir, "temporary").privateAssetReceipt,
  ).toBe(selected.receipt);
});
