import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import {
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import type { CustodianConfiguredInferenceState } from "./custodian-session-variant.ts";

export function navigateFromCustodianSetup(
  context: ApplicationContext | null,
  destination: "chat" | "model-setup" | "profile",
  inferenceState: CustodianConfiguredInferenceState,
): void {
  if (destination === "chat" && inferenceState === "utility") {
    context?.navigate("model-setup", { search: "?firstRun=1" });
  } else {
    context?.navigate(destination);
  }
}

/**
 * Route an `open-agent` reply to the destination agent chat. Resolves the
 * target session (refreshing the roster for an explicit agent), navigates to
 * it, focuses its composer, and closes the Ask OpenClaw dock when present.
 * Returns "stale" when the store's request context moved on mid-refresh.
 */
export async function performCustodianAgentHandoff(params: {
  context: ApplicationContext;
  agentId?: string;
  hatchDraft: boolean;
  isCurrent: () => boolean;
}): Promise<"navigated" | "exit-setup" | "stale"> {
  const { context } = params;
  let sessionKey = context.gateway.snapshot.sessionKey?.trim();
  if (params.agentId) {
    const roster = await context.agents.refreshList();
    if (!params.isCurrent()) {
      return "stale";
    }
    sessionKey = buildAgentMainSessionKey({ agentId: params.agentId, mainKey: roster?.mainKey });
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId: params.agentId,
    });
  }
  if (!sessionKey) {
    return "exit-setup";
  }
  const target = sessionNavigationTarget({
    face: "chat",
    sessionKey,
    fallbackAgentId: resolveSessionNavigationAgentId(context),
    basePath: context.basePath,
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
    focusComposer: !params.hatchDraft,
  });
  context.navigate("chat", {
    pathname: target.options.pathname,
    ...(params.hatchDraft
      ? { search: `?draft=${encodeURIComponent(t("custodian.hatchDraft"))}` }
      : target.options.search
        ? { search: target.options.search }
        : {}),
  });
  window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: false } }));
  return "navigated";
}
