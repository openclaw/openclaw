import { EarlyGateway } from "../api/gateway-boot.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { generateUUID } from "../lib/uuid.ts";
import { chatHistoryRequestParams } from "../pages/chat/chat-history-request-params.ts";
import type { prepareApplicationStartup } from "./bootstrap-connection.ts";
import { createGatewayCredentials } from "./gateway-store.credentials.ts";

export type EarlyApplicationGateway = {
  transport: EarlyGateway;
  credentials: ReturnType<typeof createGatewayCredentials>;
};

export function startEarlyApplicationGateway(
  initial: ReturnType<typeof prepareApplicationStartup>,
): EarlyApplicationGateway | undefined {
  const { settings, startup, applicationLocation, basePath } = initial;
  const route = sessionRefFromPath(applicationLocation.pathname, basePath);
  // Short references, native handoffs, and confirmation-required endpoints keep
  // their startup owner. A name-shaped literal is a guess: if route resolution
  // changes the target, the bounded handoff falls back to ordinary startup.
  if (
    !initial.ownsWarmBoot ||
    initial.hasPendingGateway ||
    startup.nativeClient ||
    route?.kind !== "literal" ||
    route.namespace !== "chat"
  ) {
    return undefined;
  }
  const credentials = createGatewayCredentials(true);
  const connection = credentials.prepare(
    {
      gatewayUrl: settings.gatewayUrl,
      token: settings.token,
      password: startup.password ?? "",
      bootstrapToken: startup.pendingBootstrapToken ?? "",
      ...(startup.pendingBootstrapProfile
        ? { bootstrapProfile: startup.pendingBootstrapProfile }
        : {}),
    },
    false,
    null,
  );
  const {
    sessionKey: _key,
    agentId: _agent,
    ...initialHistory
  } = chatHistoryRequestParams("chat.startup", route.sessionKey, undefined);
  const transport = new EarlyGateway(
    {
      ...connection,
      clientName: "openclaw-control-ui",
      clientVersion: CONTROL_UI_BUILD_INFO.version ?? "dev",
      clientBuildId: CONTROL_UI_BUILD_INFO.buildId,
      mode: "webchat",
      instanceId: generateUUID(),
      modelCatalog: { agentId: route.agentId, sessionKey: route.sessionKey },
    },
    route.sessionKey,
    connection.offlineRecoveryScope ? undefined : initialHistory,
    window.location.href,
  );
  return { transport, credentials };
}
