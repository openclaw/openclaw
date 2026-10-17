import type {
  ControlUiDisposer,
  ControlUiPlugin,
  ControlUiSettingsView,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { controlUiPluginAssetUrls } from "./control-ui-assets.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";
// Native views and contributions must be defined before activation can publish registrations.
import "./control-ui-view.solid.tsx";
import "./control-ui-contributions.solid.tsx";

export async function initializeControlUiPlugin(
  getContext: () => ApplicationContext,
  runtime: ControlUiPluginRuntime,
  owner: Omit<ControlUiPluginOwner, "host">,
  styles: HTMLLinkElement[],
  dispose: ControlUiDisposer,
): Promise<ControlUiPluginOwner | undefined> {
  if (!runtime.isCurrent(owner)) {
    return undefined;
  }
  const { descriptor, abort } = owner;
  const urls = controlUiPluginAssetUrls(descriptor, getContext().resourceBasePath);
  const complete: ControlUiPluginOwner = Object.assign(owner, {
    host: createControlUiPluginHost(getContext, runtime, owner),
  });
  const module = await loadControlUiPluginAssets(
    descriptor.pluginId,
    urls,
    abort.signal,
    (stop) => complete.disposers.add(stop),
    styles,
  );
  if (!runtime.isCurrent(owner)) {
    dispose();
    return undefined;
  }
  if (module.default?.id !== descriptor.pluginId || typeof module.default.activate !== "function") {
    throw new Error("Native UI entry must export its matching defineControlUiPlugin definition.");
  }
  const stop = await module.default.activate(complete.host);
  if (stop) {
    complete.disposers.add(stop);
  }
  if (!runtime.isCurrent(owner)) {
    // An initializer can finish after its deadline has already disposed the owner.
    dispose();
    return undefined;
  }
  return complete;
}

export type ControlUiPluginModule = {
  default?: ControlUiPlugin;
  pluginId?: string;
  settingsViews?: readonly ControlUiSettingsView[];
};

/** Both activation and packaged Settings presentations share one asset loader. */
export async function loadControlUiPluginAssets(
  pluginId: string,
  urls: { entry: string; styles: readonly string[] },
  signal: AbortSignal,
  retain: (dispose: ControlUiDisposer) => void,
  styles?: HTMLLinkElement[],
): Promise<ControlUiPluginModule> {
  signal.throwIfAborted();
  const stylesLoaded = urls.styles.map(async (url) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.media = "not all";
    link.href = url;
    const loaded = new Promise<void>((resolve, reject) => {
      link.addEventListener("load", () => resolve(), { once: true, signal });
      link.addEventListener(
        "error",
        () => reject(new Error(`Could not load plugin stylesheet: ${pluginId}`)),
        { once: true, signal },
      );
      signal.addEventListener("abort", () => reject(new Error("Plugin UI activation ended.")), {
        once: true,
      });
    });
    document.head.append(link);
    retain(() => link.remove());
    styles?.push(link);
    return loaded;
  });
  // Fetch code alongside CSS; publish only after this revision's styles are ready.
  const [module]: [ControlUiPluginModule, void[]] = await Promise.all([
    import(/* @vite-ignore */ urls.entry),
    Promise.all(stylesLoaded),
  ]);
  signal.throwIfAborted();
  return module;
}
