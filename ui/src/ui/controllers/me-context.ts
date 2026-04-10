import {
  CONTROL_UI_ME_CONTEXT_PATH,
  type ControlUiMeContextResponse,
  type PrivacyMode,
  type ScopeRef,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../gateway.ts";

export type MeContextState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  basePath?: string;
  meContextLoading: boolean;
  meContextError: string | null;
  currentUser: ControlUiMeContextResponse["user"] | null;
  visibleScopes: ScopeRef[];
  launchableSessionTypes: ControlUiMeContextResponse["launchableSessionTypes"];
  currentSessionType: ControlUiMeContextResponse["currentSessionType"] | null;
  shareTargets: ScopeRef[];
  selectedScope: ScopeRef | null;
  selectedPrivacyMode: PrivacyMode | null;
};

function buildMeContextPath(basePath?: string): string {
  if (!basePath) {
    return CONTROL_UI_ME_CONTEXT_PATH;
  }
  return `${basePath}${CONTROL_UI_ME_CONTEXT_PATH}`;
}

export async function loadMeContext(state: MeContextState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.meContextLoading = true;
  state.meContextError = null;
  try {
    const response = await state.client.request<ControlUiMeContextResponse>("http.fetch", {
      path: buildMeContextPath(state.basePath),
      method: "GET",
    });
    const payload =
      response && typeof response === "object" && "body" in (response as Record<string, unknown>)
        ? JSON.parse(
            typeof (response as { body?: unknown }).body === "string"
              ? (response as { body?: string }).body
              : "{}",
          )
        : response;
    const context = payload as ControlUiMeContextResponse;
    state.currentUser = context.user;
    state.visibleScopes = Array.isArray(context.visibleScopes) ? context.visibleScopes : [];
    state.launchableSessionTypes = Array.isArray(context.launchableSessionTypes)
      ? context.launchableSessionTypes
      : [];
    state.currentSessionType = context.currentSessionType ?? null;
    state.shareTargets = Array.isArray(context.shareTargets) ? context.shareTargets : [];
    state.selectedScope = context.selectedScope ?? state.visibleScopes[0] ?? null;
    state.selectedPrivacyMode =
      context.selectedPrivacyMode ?? state.selectedScope?.privacyMode ?? null;
  } catch (err) {
    state.meContextError = String(err);
  } finally {
    state.meContextLoading = false;
  }
}

export function selectMeContextScope(state: MeContextState, scopeId: string): void {
  const nextScope = state.visibleScopes.find((scope) => scope.id === scopeId) ?? null;
  state.selectedScope = nextScope;
  state.selectedPrivacyMode = nextScope?.privacyMode ?? null;
  state.currentSessionType = nextScope
    ? nextScope.type === "global"
      ? "global_chat"
      : nextScope.type === "group"
        ? "group_chat"
        : "private_chat"
    : null;

  const sessionState = state as MeContextState & {
    sessionKey?: string;
    currentUser?: { id: string } | null;
  };
  if (!nextScope || !sessionState.currentUser) {
    return;
  }

  const agentPrefix =
    typeof sessionState.sessionKey === "string" && sessionState.sessionKey.startsWith("agent:")
      ? sessionState.sessionKey.split(":").slice(0, 3).join(":")
      : "agent:main:main";

  sessionState.sessionKey = `${agentPrefix}:${nextScope.id}`;
}
