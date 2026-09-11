import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

export type AssistantDestination = "home" | "custodian";
type AssistantHomeDefaults = {
  agentsList?: ApplicationContext["agents"]["state"]["agentsList"];
  hello?: ApplicationContext["gateway"]["snapshot"]["hello"];
};

export function assistantDestinationStorageKey(scope: string): string {
  return `openclaw.assistant.panel.target.v1:${scope}`;
}

export function loadAssistantDestination(scope: string): AssistantDestination {
  let saved: Record<string, unknown> | null = null;
  try {
    saved = asNullableRecord(
      JSON.parse(getSafeLocalStorage()?.getItem(assistantDestinationStorageKey(scope)) ?? "null"),
    );
  } catch {}
  return saved?.destination === "home" ? "home" : "custodian";
}

export function resolveAssistantHomeTarget(
  defaults: AssistantHomeDefaults,
  rawSelectedId?: string | null,
) {
  const agents = listSelectableAgents(defaults.agentsList?.agents ?? []);
  const defaultId = resolveUiDefaultAgentId(defaults);
  // The sidebar switcher remains the only agent chooser for the Home dock.
  const selectedId = rawSelectedId ? normalizeAgentId(rawSelectedId) : "";
  const agentId =
    agents.find((agent) => agent.id === selectedId)?.id ??
    agents.find((agent) => agent.id === defaultId)?.id ??
    agents[0]?.id ??
    defaultId;
  return {
    ...resolveUiConversationIdentity(
      defaults,
      buildAgentMainSessionKey({ agentId, mainKey: resolveUiConfiguredMainKey(defaults) }),
      agentId,
    ),
    agentId,
  };
}

export function isAssistantDestinationSuppressed(params: {
  destination: AssistantDestination;
  custodianSuppressed: boolean;
  pageRouteId: RouteId;
  pageSessionKey: string;
  pageAgentId: string;
  defaults: AssistantHomeDefaults;
  home: ReturnType<typeof resolveAssistantHomeTarget>;
}): boolean {
  if (params.destination === "custodian") {
    return params.custodianSuppressed;
  }
  if (params.pageRouteId !== "chat") {
    return false;
  }
  const page = resolveUiConversationIdentity(
    params.defaults,
    params.pageSessionKey,
    params.pageAgentId,
  );
  return (
    page.sessionKey === params.home.sessionKey &&
    normalizeAgentId(page.agentId) === params.home.agentId
  );
}
