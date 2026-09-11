import { pathForRoute } from "../app-route-paths.ts";
import type { RouteId } from "../app-routes.ts";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import type { OpenClawAssistantPanel } from "../components/assistant-panel.ts";
import type { StartupChatPane as StartupPlaceholder } from "../components/startup-chat-skeleton.ts";
import type { ChatPane } from "../pages/chat/chat-pane-render.ts";
import { hasPresentedReplacement } from "../plugins/control-ui-view-presentation.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext } from "./context.ts";
import type { StartupPresentationController } from "./startup-presentation.ts";

interface ShellStartupHost extends HTMLElement {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly startupPresentation?: StartupPresentationController;
  readonly routeState: ShellRouteState;
  readonly workspaceChromeVisible: boolean;
  readonly assistantRestorationPending: boolean;
  readonly navigationSidebar: HTMLElement;
  requestUpdate(): void;
}

/** Reports committed route and pane readiness to the document's initial presentation. */
export class ShellStartupOwner {
  private startupIdentityOwner = "";
  private startupIdentityReady = false;
  private releasingSkeletons = false;

  constructor(private readonly host: ShellStartupHost) {}

  synchronize(sidebarFailed: boolean) {
    const host = this.host;
    const startup = host.startupPresentation;
    const context = host.context;
    if (!startup || !context || (startup.snapshot.stage === "ready" && !startup.retainSkeletons)) {
      return;
    }
    const panes = [...host.querySelectorAll<ChatPane>("openclaw-chat-pane")].filter(
      (candidate) => candidate.presented && candidate.visuallyPresented,
    );
    for (const placeholder of host.querySelectorAll<StartupPlaceholder>(
      "openclaw-startup-chat-pane",
    )) {
      const pane = panes.find(
        (candidate) =>
          candidate.paneId === placeholder.paneId && candidate.closest("openclaw-chat-page"),
      );
      if (pane?.querySelector(".agent-chat__composer-combobox textarea")) {
        // Retire duplicate controls without importing the live draft's height
        // into the original skeleton footprint, which stays fixed until exit.
        placeholder.retireComposer();
      }
    }
    if (startup.snapshot.stage === "ready") {
      if (!this.releasingSkeletons) {
        this.releasingSkeletons = true;
        // Retain the original geometry through the actual exit, then retire its
        // controls and rows. Empty animations also cover fast/reduced-motion exits.
        const exits = [
          ...host.querySelectorAll(".startup-chat-skeleton, .startup-sidebar-skeleton"),
        ].flatMap((element) => element.getAnimations().map((animation) => animation.finished));
        void Promise.allSettled(exits).then(() => {
          this.releasingSkeletons = false;
          if (host.isConnected && host.startupPresentation === startup) {
            startup.releaseSkeletons();
          }
        });
      }
      return;
    }
    const phase = context.gateway.snapshot.phase;
    if (!sidebarFailed && (phase === "starting" || phase === "connecting")) {
      return;
    }
    if (hasPresentedReplacement(host, "workspace")) {
      startup.finish();
      return;
    }
    const route = host.routeState;
    // The outlet replaces the implicit chat landing with its canonical session.
    // Its intermediate not-found is still startup, not a terminal route failure.
    if (
      !sidebarFailed &&
      phase === "connected" &&
      route.routeId === "chat" &&
      route.committedRouteStatus === "notFound" &&
      route.location?.pathname.replace(/\/$/u, "") === pathForRoute("chat", context.basePath)
    ) {
      return;
    }
    if (
      sidebarFailed ||
      route.routeFailed ||
      (route.committedRouteId === "chat" &&
        route.committedRouteStatus === "success" &&
        !route.committedSessionKey) ||
      (route.routeId && route.routeId !== "chat") ||
      phase !== "connected"
    ) {
      startup.finish();
      return;
    }
    const agentId =
      context.agentSelection.state.selectedId ?? context.gateway.snapshot.assistantAgentId;
    const owner = `${context.gateway.connectionRevision}:${agentId}:${route.location?.pathname ?? ""}`;
    if (this.startupIdentityOwner !== owner) {
      this.startupIdentityOwner = owner;
      this.startupIdentityReady = false;
      const client = context.gateway.snapshot.client;
      void context.agentIdentity.ensure([agentId]).then(() => {
        if (
          host.isConnected &&
          host.context === context &&
          this.startupIdentityOwner === owner &&
          context.gateway.snapshot.client === client
        ) {
          this.startupIdentityReady = true;
          host.requestUpdate();
        }
      });
    }
    const chromeReady = Boolean(
      !host.assistantRestorationPending &&
      !host.querySelector<OpenClawAssistantPanel>("openclaw-assistant-panel")
        ?.homePresentationPending &&
      panes.length > 0 &&
      panes.every(
        (pane) =>
          pane.composerReady && pane.querySelector(pane.compact ? ".chat" : ".chat-pane__header"),
      ) &&
      (!host.workspaceChromeVisible || host.navigationSidebar.querySelector(".sidebar-brand")) &&
      this.startupIdentityReady &&
      (context.agents.state.agentsList || context.agents.state.agentsError) &&
      (!host.workspaceChromeVisible ||
        host.querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar:defined")
          ?.sessionData.initialListReady),
    );
    startup.update(
      chromeReady,
      chromeReady &&
        [
          ...host.querySelectorAll<HTMLElementTagNameMap["openclaw-custodian-surface"]>(
            "openclaw-assistant-panel openclaw-custodian-surface",
          ),
        ].every((surface) => surface.transcriptPresentationReady) &&
        panes.every(
          (pane) =>
            !pane.conversationPresented ||
            pane.transcriptPresentationReady ||
            hasPresentedReplacement(pane, "transcript"),
        ),
    );
  }
}
