import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import {
  hasProviderBrandIcon,
  renderProviderBrandIcon,
  renderProviderFallbackIcon,
} from "../../components/provider-icon.ts";
import { fetchCatalogIconBlobUrl } from "../plugins/icon-loader.ts";
import { PluginIconController, pluginIconFetchContext } from "../plugins/plugin-icon-controller.ts";
import type { ModelSetupPageState } from "./state.ts";

type SetupIconEntry = {
  brandId?: string;
  label: string;
  icon?: string;
};

function resolveSetupBrandIcon(entry: SetupIconEntry): string | null {
  // Brand identity comes from the Gateway; never infer it from a display label.
  return entry.brandId && hasProviderBrandIcon(entry.brandId) ? entry.brandId : null;
}

export function renderProviderIcon(
  props: { iconUrls: Readonly<Record<string, string>>; onIconError: (url: string) => void },
  entry: SetupIconEntry,
  className = "",
) {
  const localBrand = resolveSetupBrandIcon(entry);
  const iconClass = `model-setup__icon ${className}`.trim();
  if (localBrand) {
    return renderProviderBrandIcon(localBrand, { className: iconClass });
  }
  const blobUrl = entry.icon ? props.iconUrls[entry.icon] : undefined;
  if (!blobUrl) {
    return renderProviderFallbackIcon(entry.label, { className: iconClass });
  }
  return html`<img
    class=${iconClass}
    src=${blobUrl}
    alt=${entry.label}
    width="24"
    height="24"
    @error=${() => props.onIconError(entry.icon!)}
  />`;
}

export function createModelSetupIconLoader(
  getContext: () => ApplicationContext,
  getPageState: () => ModelSetupPageState,
  onChange: (urls: Record<string, string>) => void,
) {
  function currentIconUrls(): Set<string> {
    const pageState = getPageState();
    if (pageState.phase !== "ready") {
      return new Set();
    }
    const result = pageState.result;
    return new Set(
      [
        ...result.candidates,
        ...result.manualProviders,
        ...(result.authOptions ?? []),
        ...(result.prepareOptions ?? []),
        ...(result.recommendedInstalls ?? []),
      ].flatMap((entry) => (entry.icon && !resolveSetupBrandIcon(entry) ? [entry.icon] : [])),
    );
  }
  const loader = new PluginIconController({
    getFetchContext: () => pluginIconFetchContext(getContext()),
    // Eligibility can change before Lit's next reconciliation callback.
    isConnected: (iconUrl) =>
      getContext().gateway.snapshot.phase === "connected" && currentIconUrls().has(iconUrl),
    fetchIcon: (iconUrl, context, signal) =>
      fetchCatalogIconBlobUrl({ iconUrl, ...context, signal }),
    timeoutError: () => new DOMException("catalog icon fetch timed out", "TimeoutError"),
    onUrlsChange: onChange,
  });
  return {
    reconcile(): void {
      const eligible = currentIconUrls();
      loader.reconcileKeys(eligible);
      for (const iconUrl of eligible) {
        loader.load(iconUrl);
      }
    },
    invalidate: (iconUrl: string) => loader.handleError(iconUrl),
    reset: () => loader.reset(),
  };
}
