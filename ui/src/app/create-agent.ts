import { routeIdFromPath } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { registerAgentCreationEnglish } from "../i18n/locales/en-agent-creation.ts";
import { AgentCreationUncertainError } from "../lib/agents/creation-recovery.runtime.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import { selectApplicationSession } from "./agent-selection.ts";
import type { ApplicationContext } from "./context.ts";
import { patchSettings } from "./settings.ts";

registerAgentCreationEnglish();

/** Creation belongs to the application, so closing the selector cannot cancel it. */
export async function createApplicationAgent(
  context: ApplicationContext,
  identity?: { name: string; avatar: string | null },
): Promise<void> {
  if (!canCallGatewayMethod(context.gateway.snapshot, "agents.create", "operator.admin")) {
    showToast({ message: t("agentChip.creationUnavailable"), durationMs: 12_000 });
    return;
  }
  const client = context.gateway.snapshot.client;
  const gatewayUrl = context.gateway.connection.gatewayUrl;
  const initialLocation = context.router.getState().location;
  const initialRouteId = routeIdFromPath(initialLocation.pathname, context.basePath);
  let location = initialLocation;
  const selectionRevision = context.agentSelection.intentRevision;
  const creation = { sessionKey: "", admitted: false };
  let clearPending = () => {};
  let created = false;
  const ownsForeground = () =>
    context.router.getState().location === location &&
    context.agentSelection.intentRevision === selectionRevision;
  const restoreUncreatedChat = () => {
    if (creation.sessionKey && ownsForeground() && initialRouteId) {
      context.replace(initialRouteId, initialLocation);
    }
  };
  try {
    const name = identity?.name.trim() || t("agentChip.newAgent");
    const result = await context.agents.create(
      name,
      (agentId) => {
        creation.sessionKey = buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: context.agents.state.agentsList,
            hello: context.gateway.snapshot.hello,
          }),
        });
        const target = sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey: creation.sessionKey,
          agentId,
          preferenceDerivedFace: true,
          exactKey: true,
        });
        clearPending = context.chatSubmissions.beginCreate({
          creation,
          message: null,
          displayName: name,
          canDisplay: () =>
            context.gateway.snapshot.client === client &&
            context.router.getState().location.pathname === target.options.pathname,
        });
        context.navigate("chat", target.options);
        location = context.router.getState().location;
      },
      identity?.avatar ? { avatar: identity.avatar } : undefined,
    );
    if (!result || context.gateway.snapshot.client !== client || !client) {
      if (context.gateway.snapshot.client === client) {
        restoreUncreatedChat();
      }
      return;
    }
    created = true;
    const { agentId, onboarding } = result;
    const sessionKey = onboarding.sessionKey;
    // A user who navigated away keeps their foreground; the agent and its chat
    // still exist and appear in the normal agent/session roster.
    creation.admitted = true;
    const foreground = ownsForeground();
    patchSettings(
      {
        gatewayUrl,
        sidebarRecentlyCreatedAgentId: agentId,
        ...(foreground ? { sidebarAgentsMode: "chip" as const } : {}),
      },
      { selectGateway: false },
    );
    if (foreground) {
      selectApplicationSession({
        selection: context.agentSelection,
        gateway: context.gateway,
        sessionKey,
        agentId,
      });
    }
    if (onboarding.status === "error") {
      throw new Error(onboarding.error);
    }
  } catch (error) {
    if (context.gateway.snapshot.client !== client) {
      return;
    }
    if (!created) {
      restoreUncreatedChat();
    }
    showToast({
      message:
        error instanceof AgentCreationUncertainError
          ? error.message
          : t(created ? "agentChip.chatStartFailed" : "agentChip.creationFailed", {
              error: formatUiError(error),
            }),
      durationMs: 12_000,
    });
  } finally {
    clearPending();
  }
}
