import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { parseControlUiFocusLocation } from "@openclaw/session-url-contract";
import { sameRouteLocation } from "../app-route-paths.ts";
import { resolveControlUiDocumentMode } from "./approval-deep-link.ts";
import { createBrowserHistory, resolveControlUiPaths } from "./browser.ts";
import { isRemoteControlUiIngress } from "./remote-ingress.ts";
import {
  loadGatewaySessionSelection,
  loadSettings,
  resolvePageGatewaySettings,
  saveSettings,
} from "./settings.ts";
import {
  normalizeLegacyTerminalViewLocation,
  resolveApplicationStartupSettings,
} from "./startup-settings.ts";

/** Resolve the document's connection once, before either transport or rendering starts. */
export function prepareApplicationStartup() {
  const history = createBrowserHistory();
  const startupLocation = history.location();
  const [basePath, resourceBasePath] = resolveControlUiPaths(
    startupLocation.pathname || globalThis.location?.pathname || "/",
  );
  const documentMode = resolveControlUiDocumentMode(startupLocation.pathname, basePath);
  const persistedSettings = loadSettings();
  const initialSettings = documentMode
    ? resolvePageGatewaySettings(persistedSettings)
    : persistedSettings;
  const startup = resolveApplicationStartupSettings(initialSettings, startupLocation);
  const startupTargetSelection =
    gatewayOriginScope(startup.settings.gatewayUrl) ===
    gatewayOriginScope(initialSettings.gatewayUrl)
      ? null
      : loadGatewaySessionSelection(startup.settings.gatewayUrl);
  const settings = startupTargetSelection
    ? {
        ...startup.settings,
        ...startupTargetSelection,
        selectedAgentId: startupTargetSelection.selectedAgentId,
      }
    : startup.settings;
  if (!sameRouteLocation(startup.location, startupLocation)) {
    // Remove URL credentials before deferred routing or Gateway authentication can expose them.
    history.replace(startup.location);
  }
  if (startup.changed && !documentMode) {
    saveSettings(settings);
  }
  const applicationLocation = normalizeLegacyTerminalViewLocation(startup.location, basePath);
  if (applicationLocation !== startup.location) {
    history.replace(applicationLocation);
  }
  const focusLocation = parseControlUiFocusLocation(applicationLocation, basePath);
  // Focus documents render before the shell; starting the application router
  // would rewrite their reserved presentation route into an ordinary page.
  const startsApplicationRouter = documentMode === null && focusLocation === null;
  // The live grant determines the person; a previous relay visitor's credential cannot warm-admit it.
  const ownsWarmBoot = startsApplicationRouter && !isRemoteControlUiIngress();
  const hasPendingGateway = startup.pendingGatewayUrl !== null;
  return {
    history,
    basePath,
    resourceBasePath,
    documentMode,
    startup,
    settings,
    applicationLocation,
    focusLocation,
    startsApplicationRouter,
    ownsWarmBoot,
    hasPendingGateway,
  };
}
