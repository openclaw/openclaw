import { raceWithTimeout } from "@openclaw/retry";
import type { ControlUiSettingsPlacement } from "../../../src/plugin-sdk/control-ui-settings.js";
import { listen } from "../lib/reactive/listener.ts";
import { controlUiPluginDistributions } from "./control-ui-distribution.ts";

function sameSettingsPlacement(a: ControlUiSettingsPlacement, b: ControlUiSettingsPlacement) {
  return (
    a.section === b.section &&
    a.panel === b.panel &&
    (a.section !== "channels" || (b.section === "channels" && a.channelId === b.channelId))
  );
}

export async function loadPackagedSettingsView(
  placement: ControlUiSettingsPlacement,
  signal: AbortSignal,
  lifetimes: Set<AbortController>,
) {
  signal.throwIfAborted();
  const matches = controlUiPluginDistributions.filter((entry) =>
    entry.settingsViews?.some((item) => sameSettingsPlacement(item, placement)),
  );
  if (matches.length !== 1) {
    throw new Error("Settings presentation requires one packaged owner.");
  }
  const distribution = matches[0]!;
  const abort = new AbortController();
  const lifetime = AbortSignal.any([signal, abort.signal]);
  const disposers = new Set<() => void>();
  let retired = false;
  const dispose = () => {
    if (retired) {
      return;
    }
    retired = true;
    abort.abort();
    for (const stop of disposers) {
      stop();
    }
    disposers.clear();
    lifetimes.delete(abort);
  };
  lifetimes.add(abort);
  disposers.add(listen(lifetime, "abort", dispose, { once: true }));
  const styles: HTMLLinkElement[] = [];
  try {
    const { loadControlUiPluginAssets } = await import("./control-ui-loader.ts");
    const module = await raceWithTimeout(
      loadControlUiPluginAssets(
        distribution.pluginId,
        distribution,
        lifetime,
        (stop) => disposers.add(stop),
        styles,
      ),
      15_000,
      () => {
        throw new Error("Settings presentation timed out.");
      },
    );
    lifetime.throwIfAborted();
    if (
      module.pluginId !== distribution.pluginId ||
      !Array.isArray(module.settingsViews) ||
      module.settingsViews.length !== distribution.settingsViews?.length
    ) {
      throw new Error("Settings presentation does not match its packaged owner and placements.");
    }
    const declared = module.settingsViews.every(
      (view) =>
        typeof view.mount === "function" &&
        distribution.settingsViews?.some((item) => sameSettingsPlacement(item, view.placement)),
    );
    const views = module.settingsViews.filter((view) =>
      sameSettingsPlacement(view.placement, placement),
    );
    const view = views[0];
    if (!declared || views.length !== 1 || !view) {
      throw new Error("Invalid or duplicate Settings presentation.");
    }
    for (const style of styles) {
      style.media = "all";
    }
    return { view, signal: lifetime, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
