import type { PluginControlUiModule } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { controlUiPluginAssetPrefix } from "../../../src/gateway/control-ui-plugin-assets-contract.js";
import type { ApplicationConfigCapability } from "../app/config.ts";
import { uiDevGatewayResourceUrl } from "../dev-gateway.ts";

export function controlUiPluginAssetGrantError(
  descriptor: PluginControlUiModule,
  config: Pick<
    ApplicationConfigCapability["current"],
    "pluginAssetsRequireAuth" | "pluginFrameGrants"
  >,
  basePath: string,
): string | null {
  if (!config.pluginAssetsRequireAuth) {
    return null;
  }
  // Secure asset cookies cannot authenticate requests from non-local HTTP.
  if (!window.isSecureContext) {
    return "Native plugin UI requires HTTPS or localhost to authenticate its assets. Open this Gateway through HTTPS/Tailscale Serve, or use its loopback dashboard.";
  }
  return config.pluginFrameGrants.some(
    (grant) =>
      grant.pluginId === descriptor.pluginId &&
      grant.match === "prefix" &&
      grant.path === controlUiPluginAssetPrefix(descriptor.pluginId, basePath),
  )
    ? null
    : `Native plugin asset grant unavailable: ${descriptor.pluginId}`;
}

export function controlUiPluginAssetUrls(descriptor: PluginControlUiModule, basePath: string) {
  const prefix = `${controlUiPluginAssetPrefix(descriptor.pluginId, basePath)}${encodeURIComponent(descriptor.revision)}/`;
  const resolve = (path: string) => {
    const url = new URL(uiDevGatewayResourceUrl(path), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(prefix)) {
      throw new Error("Native plugin assets must be served by this Control UI Gateway.");
    }
    return url.href;
  };
  return {
    entry: resolve(descriptor.entryUrl),
    styles: descriptor.styles.map(resolve),
    imports: (descriptor.imports ?? []).map(resolve),
  };
}

export class ControlUiPluginAssetPreloads {
  private readonly links = new Map<string, HTMLLinkElement>();

  sync(
    config: ApplicationConfigCapability["current"],
    basePath: string,
    onError: (pluginId: string, error: unknown) => void,
  ): void {
    const wanted = new Map<string, "modulepreload" | "preload">();
    for (const descriptor of config.pluginControlUiModules) {
      if (controlUiPluginAssetGrantError(descriptor, config, basePath)) {
        continue;
      }
      let urls: ReturnType<typeof controlUiPluginAssetUrls>;
      try {
        urls = controlUiPluginAssetUrls(descriptor, basePath);
      } catch (error) {
        onError(descriptor.pluginId, error);
        continue;
      }
      for (const url of [urls.entry, ...urls.imports]) {
        wanted.set(url, "modulepreload");
      }
      for (const url of urls.styles) {
        wanted.set(url, "preload");
      }
    }
    for (const [url, link] of this.links) {
      if (!wanted.has(url)) {
        link.remove();
        this.links.delete(url);
      }
    }
    for (const [url, rel] of wanted) {
      if (this.links.has(url)) {
        continue;
      }
      const link = document.createElement("link");
      link.rel = rel;
      if (rel === "preload") {
        link.as = "style";
      }
      link.href = url;
      this.links.set(url, link);
      document.head.append(link);
    }
  }

  dispose(): void {
    for (const link of this.links.values()) {
      link.remove();
    }
    this.links.clear();
  }
}
