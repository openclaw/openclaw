import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { parseControlUiFocusLocation } from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import { sameRouteLocation } from "../app-route-paths.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import {
  buildAgentMainSessionKey,
  isDashboardSessionKey,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { prewarmChatSnapshot } from "../pages/chat/chat-snapshot-prewarm.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import { resolveControlUiDocumentMode } from "./approval-deep-link.ts";
import type { BootRecord } from "./boot-record.ts";
import { createBrowserHistory, resolveControlUiPaths } from "./browser.ts";
import { readCredentialBootRecord } from "./gateway-store.credentials.ts";
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

function prewarmBootChat(
  record: BootRecord,
  lastSessionKey: string,
  location: RouteLocation,
  basePath: string,
): void {
  const target = sessionRefFromPath(location.pathname, basePath, record.agents.mainKey);
  const path = location.pathname.slice(basePath.length).replace(/\/$/u, "");
  if (!target && path !== "" && path !== "/chat") {
    return;
  }
  // Dashboard names are ambiguous until the roster resolves them. Warm one
  // same-agent last-viewed candidate; only the route's exact key can consume it.
  const savedDashboardCandidate =
    target?.namespace === "dashboard" &&
    target.kind === "literal" &&
    target.slugCandidate &&
    isDashboardSessionKey(lastSessionKey) &&
    parseAgentSessionKey(lastSessionKey)?.agentId === target.agentId;
  const sessionKey = savedDashboardCandidate
    ? lastSessionKey
    : target?.kind === "main"
      ? buildAgentMainSessionKey({ agentId: target.agentId, mainKey: record.agents.mainKey })
      : target?.kind === "literal"
        ? target.sessionKey
        : lastSessionKey;
  if (target?.kind === "short" && parseAgentSessionKey(sessionKey)?.agentId !== target.agentId) {
    return;
  }
  if (parseAgentSessionKey(sessionKey)) {
    void prewarmChatSnapshot(
      resolveChatSnapshotKey(
        {
          agentsList: record.agents,
          hello: null,
          assistantAgentId: null,
          settings: { gatewayUrl: record.scope },
          client: { offlineRecoveryScope: record.recoveryScope },
        },
        { sessionKey },
      ),
    );
  }
}

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
  const readStartupBootRecord = () =>
    ownsWarmBoot && !hasPendingGateway
      ? readCredentialBootRecord({
          gatewayUrl: settings.gatewayUrl,
          token: settings.token,
          bootstrapToken: startup.pendingBootstrapToken ?? "",
          password: startup.password ?? "",
        })
      : null;
  let snapshotReadStarted = false;
  return {
    get bootRecord() {
      // Module loading can outlive a peer's retirement of the startup owner.
      return readStartupBootRecord();
    },
    prewarmChatSnapshot() {
      if (!snapshotReadStarted) {
        snapshotReadStarted = true;
        const bootRecord = readStartupBootRecord();
        if (!bootRecord) {
          return;
        }
        prewarmBootChat(bootRecord, settings.sessionKey, applicationLocation, basePath);
      }
    },
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
