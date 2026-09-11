import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import {
  hasProviderBrandIcon,
  renderProviderBrandIcon,
  renderProviderFallbackIcon,
} from "../../components/provider-icon.ts";
import { fetchCatalogIconBlobUrl } from "../plugins/icon-loader.ts";
import { PluginIconController } from "../plugins/plugin-icon-controller.ts";
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
  if (localBrand) {
    return renderProviderBrandIcon(localBrand, {
      className: `model-setup__icon ${className}`.trim(),
    });
  }
  const blobUrl = entry.icon ? props.iconUrls[entry.icon] : undefined;
  if (!entry.icon || !blobUrl) {
    return renderProviderFallbackIcon(entry.label, {
      className: `model-setup__icon ${className}`.trim(),
    });
  }
  return html`<img
    class=${`model-setup__icon ${className}`.trim()}
    src=${blobUrl}
    alt=${entry.label}
    width="24"
    height="24"
    @error=${() => props.onIconError(entry.icon!)}
  />`;
}

export class ModelSetupIconLoader {
  private readonly loader: PluginIconController;

  constructor(
    private readonly getContext: () => ApplicationContext,
    private readonly getPageState: () => ModelSetupPageState,
    private readonly onChange: (urls: Record<string, string>) => void,
  ) {
    this.loader = new PluginIconController({
      getFetchContext: () => {
        const context = this.getContext();
        return {
          resourceBasePath: context.resourceBasePath,
          gatewayUrl: context.gateway.connection.gatewayUrl,
          auth: {
            hello: context.gateway.snapshot.hello,
            settings: { token: context.gateway.connection.token },
            password: context.gateway.connection.password,
          },
        };
      },
      // Eligibility can change before Lit's next reconciliation callback.
      isConnected: (iconUrl) =>
        this.getContext().gateway.snapshot.phase === "connected" &&
        this.currentIconUrls().has(iconUrl),
      fetchIcon: (iconUrl, context, signal) =>
        fetchCatalogIconBlobUrl({ iconUrl, ...context, signal }),
      timeoutError: () => new DOMException("catalog icon fetch timed out", "TimeoutError"),
      onUrlsChange: (urls) => this.onChange(urls),
    });
  }

  reconcile(): void {
    const eligible = this.currentIconUrls();
    this.loader.reconcileKeys(eligible);
    for (const iconUrl of eligible) {
      this.loader.load(iconUrl);
    }
  }

  invalidate(iconUrl: string): void {
    this.loader.handleError(iconUrl);
  }

  reset(): void {
    this.loader.reset();
  }

  private currentIconUrls(): Set<string> {
    const pageState = this.getPageState();
    if (pageState.phase !== "ready") {
      return new Set();
    }
    const result = pageState.result;
    return new Set(
      [
        ...result.candidates,
        ...(result.unavailableCandidates ?? []),
        ...result.manualProviders,
        ...(result.authOptions ?? []),
        ...(result.prepareOptions ?? []),
        ...(result.recommendedInstalls ?? []),
      ].flatMap((entry) => (entry.icon && !resolveSetupBrandIcon(entry) ? [entry.icon] : [])),
    );
  }
}
