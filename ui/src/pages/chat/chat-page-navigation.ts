import type { ApplicationContext } from "../../app/context.ts";
import type { UiCommandDetail } from "../../components/panel-toggle-contract.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";
import { currentRouteLocation } from "./chat-canonical-location.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./session-route-data.ts";
import type { ChatSplitLayout, ChatSplitPane } from "./split-layout-types.ts";
import { applyUiCommandToSplitLayout, findPane, panesOf } from "./split-layout.ts";

const paneRouteData = new WeakMap<
  SessionChatRouteData,
  { sessionKey: string; value: SessionChatRouteData }
>();

export function sameChatPaneRoute(
  context: ApplicationContext,
  before: SessionChatRouteData | undefined,
  after: SessionChatRouteData | undefined,
): boolean {
  return Boolean(
    before &&
    after &&
    uiConversationMatches(
      { agentsList: context.agents.state.agentsList, hello: context.gateway.snapshot.hello },
      before.sessionKey,
      after.sessionKey,
      after.agentId,
      before.agentId,
    ),
  );
}

function ownedChatPaneCommand(
  context: ApplicationContext,
  params: UiCommandDetail,
): UiCommandDetail {
  const { command, agentId } = params;
  if (
    command.kind !== "navigate" &&
    command.kind !== "split" &&
    command.kind !== "focus" &&
    command.kind !== "close-pane"
  ) {
    return params;
  }
  return {
    ...params,
    sessionKey: params.sessionKey
      ? ownedChatPaneSessionKey(context, params.sessionKey, agentId)
      : undefined,
    command: {
      ...command,
      sessionKey: ownedChatPaneSessionKey(context, command.sessionKey, agentId),
    },
  };
}

export function ownedChatPaneRouteData(
  context: ApplicationContext,
  data: SessionChatRouteData,
): SessionChatRouteData {
  if (!isUiGlobalSessionKey(data?.sessionKey) || !data.agentId?.trim()) {
    return data;
  }
  const sessionKey = ownedChatPaneSessionKey(context, data.sessionKey, data.agentId);
  if (sessionKey === data.sessionKey) {
    return data;
  }
  let cached = paneRouteData.get(data);
  // Route identity owns one-shot draft/focus consumption; keep the projection stable.
  if (cached?.sessionKey !== sessionKey) {
    cached = { sessionKey, value: { ...data, sessionKey } };
    paneRouteData.set(data, cached);
  }
  return cached.value;
}

export function ownedChatPaneSessionKey(
  context: ApplicationContext,
  sessionKey: string,
  agentId?: string,
): string {
  return isUiGlobalSessionKey(sessionKey) &&
    agentId?.trim() &&
    isUiGlobalScopeConfigured({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    })
    ? buildAgentMainSessionKey({
        agentId,
        mainKey: resolveUiConfiguredMainKey({
          agentsList: context.agents.state.agentsList,
          hello: context.gateway.snapshot.hello,
        }),
      })
    : sessionKey;
}

export function navigateChatPage(
  context: ApplicationContext,
  data: SessionChatRouteData | undefined,
  sessionKey: string,
  replace = false,
  explicitFace?: BoardFace,
  targetAgentId?: string,
): void {
  const agentId = resolveSessionNavigationAgentId(context, targetAgentId ?? data?.agentId);
  // Adopting a canonical global spelling is not a new conversation. Re-resolving
  // its face before the roster arrives makes cached alias/global routes alternate.
  const sameSession =
    data &&
    uiConversationMatches(
      {
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
        assistantAgentId: agentId,
      },
      data.sessionKey,
      sessionKey,
      isUiGlobalSessionKey(sessionKey) ? agentId : undefined,
      data.agentId,
    );
  let face = explicitFace ?? data?.face ?? "chat";
  if (explicitFace === undefined && !sameSession) {
    face = resolveSessionPreferredFaceForKey(context, sessionKey, targetAgentId ?? data?.agentId);
  }
  const options = sessionNavigationTarget({
    context,
    face,
    preferenceDerivedFace: explicitFace === undefined && !sameSession,
    sessionKey,
    agentId: targetAgentId ?? data?.agentId,
    shortIdLength: data?.sessionKey === sessionKey ? data.shortId?.length : undefined,
  }).options;
  const location =
    replace && sameSession && (data.draft || data.focusComposer)
      ? locationWithoutDraft(currentRouteLocation(), options)
      : options;
  context[replace ? "replace" : "navigate"](face, location);
}

type ChatPageCommandHost = {
  context: ApplicationContext;
  data: SessionChatRouteData;
  presented: boolean;
  pendingCreate: boolean;
  narrow: boolean;
  layout: ChatSplitLayout | undefined;
  unboundPaneIds: ReadonlySet<string>;
  classicLayout: (key: string) => ChatSplitLayout;
  adoptPaneNavigation: (paneId: string, key: string, agentId?: string) => void;
  updateRoute: (key: string, replace?: boolean, face?: BoardFace, agentId?: string) => void;
  closeSplitPane: (layout: ChatSplitLayout, paneId: string) => void;
  persistLayout: (layout: ChatSplitLayout | undefined) => void;
  updateRouteToPane: (pane: ChatSplitPane) => void;
};

export function handleChatPageCommand(event: Event, host: ChatPageCommandHost): void {
  if (!host.presented || host.pendingCreate || !(event instanceof CustomEvent)) {
    return;
  }
  const {
    command,
    sessionKey: sourceSessionKey,
    agentId,
  } = ownedChatPaneCommand(
    host.context,
    // SAFETY: UI_COMMAND_EVENT comes from the validated Gateway adapter or typed local actions.
    event.detail as UiCommandDetail,
  );
  if (command.kind === "navigate") {
    event.preventDefault();
    if (host.layout && host.unboundPaneIds.has(host.layout.activePaneId)) {
      host.adoptPaneNavigation(host.layout.activePaneId, command.sessionKey, agentId);
    }
    host.updateRoute(command.sessionKey, false, undefined, agentId);
    return;
  }
  if (command.kind !== "split" && command.kind !== "close-pane" && command.kind !== "focus") {
    return;
  }
  if (command.kind === "split" && host.narrow) {
    return;
  }

  const currentSessionKey = ownedChatPaneRouteData(host.context, host.data)?.sessionKey?.trim();
  const layout =
    host.layout ??
    (command.kind === "split" && currentSessionKey
      ? host.classicLayout(currentSessionKey)
      : undefined);
  if (!layout) {
    return;
  }
  if (command.kind === "close-pane") {
    const targetPane = panesOf(layout).find((pane) => pane.sessionKey === command.sessionKey);
    if (!targetPane) {
      return;
    }
    event.preventDefault();
    host.closeSplitPane(layout, targetPane.id);
    return;
  }
  const next = applyUiCommandToSplitLayout(layout, command, sourceSessionKey);
  if (next === layout) {
    return;
  }
  event.preventDefault();
  host.persistLayout(next);
  const activePane = next && findPane(next, next.activePaneId)?.pane;
  if (activePane) {
    host.updateRouteToPane(activePane);
  }
}
