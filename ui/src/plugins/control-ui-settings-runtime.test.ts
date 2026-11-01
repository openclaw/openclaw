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
it.each(["memories", "channel"] as const)(
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
it.each(["disposed", "ambiguous"])("rejects a %s owner before loading code", async (cause) => {
  const f = fixture();
  const pending = f.load();
  if (cause === "disposed") {
    f.runtime.dispose();
  } else {
    packaged.push({ ...packaged[0]!, pluginId: "duplicate" });
  }
  await expect(pending).rejects.toThrow(
    cause === "disposed" ? "runtime has ended" : "one packaged owner",
  );
  expect(loadControlUiPluginAssets).not.toHaveBeenCalled();
});
it.each(["owner", "placement", "duplicate", "channel"])(
  "rejects a built module with a mismatched %s and disposes its styles",
  async (kind) => {
    const f = fixture(kind === "channel" ? [channelView()] : undefined);
    if (kind === "owner") {
      f.module.pluginId = "another-plugin";
    }
    if (kind === "placement") {
      f.module.settingsViews = [channelView()];
    }
    if (kind === "duplicate") {
      f.module.settingsViews = [f.view, f.view];
    }
    if (kind === "channel") {
      f.module.settingsViews = [channelView("foreign")];
    }
    await expect(f.load()).rejects.toThrow(kind === "channel" ? "Invalid or duplicate" : undefined);
    expect(f.style.media).toBe("not all");
    expect(f.stop).toHaveBeenCalledOnce();
  },
);
