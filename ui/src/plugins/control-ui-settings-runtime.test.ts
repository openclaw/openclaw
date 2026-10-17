import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiSettingsView } from "../../../src/plugin-sdk/control-ui.js";
import type { ControlUiPluginDistribution } from "./control-ui-distribution.ts";
import { loadControlUiPluginAssets } from "./control-ui-loader.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

// mock-isolation: synthetic packaged modules replace the real loader's DOM/network acquisition and host rendering imports.
vi.mock("./control-ui-loader.ts", () => ({ loadControlUiPluginAssets: vi.fn() }));
const packaged = vi.hoisted(() => [] as ControlUiPluginDistribution[]);
vi.mock("./control-ui-distribution.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-distribution.ts")>()),
  controlUiPluginDistributions: packaged,
}));
afterEach(() => {
  packaged.length = 0;
  vi.resetAllMocks();
});
const placement = { section: "memory", panel: "overview" } as const;
function fixture() {
  packaged.push({
    pluginId: "fixture",
    revision: "built-revision",
    bundledDistribution: { packageName: "fixture", packageVersion: "1.0.0" },
    activation: "settings-only",
    settingsViews: [placement],
    entry: "/packaged/index.js",
    styles: ["/packaged/index.css"],
    imports: [],
  });
  const view: ControlUiSettingsView = { placement, mount: vi.fn() };
  const activate = vi.fn();
  const stop = vi.fn();
  const style = document.createElement("link");
  style.media = "not all";
  const module = {
    pluginId: "fixture",
    settingsViews: [view],
    default: { id: "fixture", activate },
  };
  vi.mocked(loadControlUiPluginAssets).mockImplementation(
    async (_id, _urls, _signal, retain, styles) => {
      retain(stop);
      styles?.push(style);
      return module;
    },
  );
  const runtime = new ControlUiPluginRuntime(() => {
    throw new Error("Settings loading must not read the active catalog");
  });
  return { runtime, view, activate, stop, style, module };
}
it("loads packaged Settings independently and retires its assets with the runtime", async () => {
  const f = fixture();
  const loaded = await f.runtime.loadSettingsView(placement, new AbortController().signal);
  expect(loaded.view).toBe(f.view);
  expect(f.style.media).toBe("all");
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.runtime.hasPlugins).toBe(false);
  f.runtime.dispose();
  expect(loaded.signal.aborted).toBe(true);
  expect(f.stop).toHaveBeenCalledOnce();
  loaded.dispose();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("selects Memories from a package that also owns Overview without runtime activation", async () => {
  const f = fixture();
  const memories: ControlUiSettingsView = {
    placement: { section: "memory", panel: "memories" },
    mount: vi.fn(),
  };
  packaged[0]!.settingsViews = [placement, memories.placement];
  f.module.settingsViews.push(memories);
  try {
    const loaded = await f.runtime.loadSettingsView(
      memories.placement,
      new AbortController().signal,
    );
    expect(loaded.view).toBe(memories);
    expect(f.activate).not.toHaveBeenCalled();
    loaded.dispose();
    expect(f.stop).toHaveBeenCalledOnce();
  } finally {
    f.runtime.dispose();
  }
});
it("rejects ambiguous packaged placement owners before loading code", async () => {
  const f = fixture();
  packaged.push({ ...packaged[0]!, pluginId: "duplicate" });
  await expect(f.runtime.loadSettingsView(placement, new AbortController().signal)).rejects.toThrow(
    "one packaged owner",
  );
  expect(loadControlUiPluginAssets).not.toHaveBeenCalled();
  f.runtime.dispose();
});
it.each(["owner", "placement", "duplicate"])(
  "rejects a built module with a mismatched %s and disposes its styles",
  async (kind) => {
    const f = fixture();
    if (kind === "owner") {
      f.module.pluginId = "another-plugin";
    }
    if (kind === "placement") {
      f.module.settingsViews = [
        {
          ...f.view,
          placement: { section: "other", panel: "overview" },
        } as unknown as ControlUiSettingsView,
      ];
    }
    if (kind === "duplicate") {
      f.module.settingsViews = [f.view, f.view];
    }
    await expect(
      f.runtime.loadSettingsView(placement, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.style.media).toBe("not all");
    expect(f.stop).toHaveBeenCalledOnce();
    f.runtime.dispose();
  },
);
