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
}
