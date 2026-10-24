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
type SettingsView = ControlUiSettingsView | ControlUiChannelSettingsView;
const memoryView = (panel: "overview" | "memories" = "overview"): ControlUiSettingsView => ({
  placement: { ...placement, panel },
  mount: vi.fn(),
});
const channelView = (channelId = "custom"): ControlUiChannelSettingsView => ({
  placement: { section: "channels", panel: "detail", channelId },
  mount: vi.fn(),
});
function fixture(views: SettingsView[] = [memoryView()]) {
  packaged.push({
    pluginId: "fixture",
    revision: "built-revision",
    bundledDistribution: { packageName: "fixture", packageVersion: "1.0.0" },
    activation: "settings-only",
    settingsViews: views.map((view) => view.placement),
    entry: "/packaged/index.js",
    styles: ["/packaged/index.css"],
    imports: [],
  });
  const view = views[0]!;
  const activate = vi.fn();
  const stop = vi.fn();
  const style = document.createElement("link");
  style.media = "not all";
  const module = {
    pluginId: "fixture",
    settingsViews: views,
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
  const load = (target = view) =>
    target.placement.section === "memory"
      ? runtime.loadSettingsView(target.placement, new AbortController().signal)
      : runtime.loadSettingsView(target.placement, new AbortController().signal);
  return { runtime, view, activate, stop, style, module, load };
}
it.each(["overview", "memories", "channel"] as const)(
  "loads and disposes packaged %s without activation",
  async (kind) => {
    const selected = kind === "channel" ? channelView() : memoryView(kind);
    const f = fixture(kind === "memories" ? [memoryView(), selected] : [selected]);
    const loaded = await f.load(selected);
    expect(loaded.view).toBe(selected);
    expect(f.style.media).toBe("all");
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.runtime.hasPlugins).toBe(false);
    if (kind === "channel") {
      await expect(f.load(channelView("foreign"))).rejects.toThrow("one packaged owner");
    }
    if (kind === "memories") {
      loaded.dispose();
    } else {
      f.runtime.dispose();
    }
    expect(loaded.signal.aborted).toBe(true);
    expect(f.stop).toHaveBeenCalledOnce();
    loaded.dispose();
    expect(f.stop).toHaveBeenCalledOnce();
  },
);
it("does not start a Settings view after disposal during its lazy import", async () => {
  const f = fixture();
  const pending = f.runtime.loadSettingsView(placement, new AbortController().signal);
  f.runtime.dispose();
  await expect(pending).rejects.toThrow("The plugin UI runtime has ended.");
  expect(loadControlUiPluginAssets).not.toHaveBeenCalled();
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

it("rejects module channel identity drift even when section and panel match", async () => {
  const view = channelView();
  const f = fixture([view]);
  f.module.settingsViews = [{ ...view, placement: { ...view.placement, channelId: "foreign" } }];
  await expect(f.load()).rejects.toThrow("Invalid or duplicate");
});
