import { afterEach, expect, it, vi } from "vitest";
import type {
  ControlUiSettingsView,
  ControlUiChannelSettingsView,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ControlUiPluginDistribution } from "./control-ui-distribution.ts";
import { loadControlUiPluginAssets } from "./control-ui-loader.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

// mock-isolation: synthetic packaged modules replace the real loader's DOM/network acquisition and host rendering imports.
vi.mock("./control-ui-loader.ts", () => ({ loadControlUiPluginAssets: vi.fn() }));
const packaged = vi.hoisted(() => [] as ControlUiPluginDistribution[]);
const runtimes: ControlUiPluginRuntime[] = [];
vi.mock("./control-ui-distribution.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-distribution.ts")>()),
  controlUiPluginDistributions: packaged,
}));
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
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
  runtimes.push(runtime);
  const load = (target: ControlUiSettingsView["placement"] = placement) =>
    runtime.loadSettingsView(target, new AbortController().signal);
  const channel = { section: "channels", panel: "detail", channelId: "custom" } as const;
  return { runtime, view, activate, stop, style, module, load, channel };
}
it("loads packaged Settings independently and retires its assets with the runtime", async () => {
  const f = fixture();
  const loaded = await f.load();
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
it("does not start a Settings view after disposal during its lazy import", async () => {
  const f = fixture();
  const pending = f.runtime.loadSettingsView(placement, new AbortController().signal);
  f.runtime.dispose();
  await expect(pending).rejects.toThrow("The plugin UI runtime has ended.");
  expect(loadControlUiPluginAssets).not.toHaveBeenCalled();
});
it("selects Memories from a package that also owns Overview without runtime activation", async () => {
  const f = fixture();
  const memories: ControlUiSettingsView = {
    placement: { section: "memory", panel: "memories" },
    mount: vi.fn(),
  };
  packaged[0]!.settingsViews = [placement, memories.placement];
  f.module.settingsViews.push(memories);
  const loaded = await f.load(memories.placement);
  expect(loaded.view).toBe(memories);
  expect(f.activate).not.toHaveBeenCalled();
  loaded.dispose();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("rejects ambiguous packaged placement owners before loading code", async () => {
  const f = fixture();
  packaged.push({ ...packaged[0]!, pluginId: "duplicate" });
  await expect(f.load()).rejects.toThrow("one packaged owner");
  expect(loadControlUiPluginAssets).not.toHaveBeenCalled();
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
    await expect(f.load()).rejects.toThrow();
    expect(f.style.media).toBe("not all");
    expect(f.stop).toHaveBeenCalledOnce();
  },
);

it("binds channel settings loading to the declared channel without runtime activation", async () => {
  const f = fixture();
  const view: ControlUiChannelSettingsView = {
    placement: f.channel,
    mount: vi.fn(),
  };
  packaged[0]!.settingsViews = [view.placement];
  vi.mocked(loadControlUiPluginAssets).mockResolvedValue({
    pluginId: "fixture",
    settingsViews: [view],
    default: { id: "fixture", activate: f.activate },
  });
  const loaded = await f.runtime.loadSettingsView(view.placement, new AbortController().signal);
  expect(loaded.view).toBe(view);
  expect(f.activate).not.toHaveBeenCalled();
  await expect(
    f.runtime.loadSettingsView(
      { ...view.placement, channelId: "foreign" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("one packaged owner");
  f.runtime.dispose();
  expect(loaded.signal.aborted).toBe(true);
});
it("rejects module channel identity drift even when section and panel match", async () => {
  const f = fixture();
  packaged[0]!.settingsViews = [f.channel];
  vi.mocked(loadControlUiPluginAssets).mockResolvedValue({
    pluginId: "fixture",
    settingsViews: [{ placement: { ...f.channel, channelId: "foreign" }, mount: vi.fn() }],
  });
  await expect(f.runtime.loadSettingsView(f.channel, new AbortController().signal)).rejects.toThrow(
    "Invalid or duplicate",
  );
});
