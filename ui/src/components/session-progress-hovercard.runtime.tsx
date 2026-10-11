import type { ProgressCard, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { render } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, onSettled, runWithOwner } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { resolveControlUiAvatarAuth } from "../app/control-ui-auth.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";
import {
  sessionPullRequestsForGateway,
  type SessionPullRequestSnapshotStore,
} from "../lib/session-pull-requests.ts";
import { parseAgentSessionKey, scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { personActivityRouting, type PersonActivityRouting } from "./person-activity-link.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { SessionHovercard, type SessionHovercardInput } from "./session-hovercard-solid.tsx";
import { SessionLinkTitler } from "./session-link-titling.ts";
import {
  SESSION_MENU_OPEN_EVENT,
  sessionProgressHoverPlacementForTarget,
  sessionProgressHoverTargetFromEvent,
} from "./session-progress-hovercard-target.ts";

const OPEN_DELAY_MS = 450;
const SWEEP_OPEN_DELAY_MS = 80;
const SKIP_DELAY_MS = 300;
const CLOSE_DELAY_MS = 100;
const EXIT_DURATION_MS = 100;
let nextHovercardId = 0;

function sessionHovercardMenuOpen(owner: ParentNode): boolean {
  return owner.querySelector("openclaw-session-menu, openclaw-catalog-session-menu") !== null;
}

type SessionProgressHovercardProps = {
  client: GatewayBrowserClient | null;
  context: ApplicationContext | null;
  gateway: ApplicationGateway | null;
};

export type SessionProgressHovercardProvider = SolidBridgeElement<SessionProgressHovercardProps>;

class SessionProgressHovercardController {
  private readonly sessionLinkTitler: SessionLinkTitler;
  private readonly cardUpdates = new WeakMap<
    HTMLDivElement,
    (input: SessionHovercardInput, afterCommit: () => void) => void
  >();

  constructor(private readonly host: HTMLElement) {
    this.sessionLinkTitler = new SessionLinkTitler(host);
  }

  private applicationClient: GatewayBrowserClient | null = null;
  private applicationContext: ApplicationContext | null = null;
  private applicationGateway: ApplicationGateway | null = null;
  private progressCards: SessionProgressCardStore | null = null;
  private stopProgressCardUpdates: (() => void) | null = null;
  private stopContextUpdates: (() => void) | null = null;
  private pullRequests: SessionPullRequestSnapshotStore | null = null;
  private stopPullRequestUpdates: (() => void) | null = null;
  private activeTarget: HTMLElement | null = null;
  private activeTrigger: HTMLElement | null = null;
  private activeSession: ProgressCardGetParams | null = null;

  private get activeArtifactKey(): string | null {
    return this.activeSession
      ? scopedSessionArtifactKey(this.activeSession.sessionKey, this.activeSession.agentId)
      : null;
  }
  private open = false;
  private delayed = true;
  private animateNextOpen = true;
  private skipDelayTimer: number | null = null;
  private lastProgressCard: ProgressCard | null = null;
  private readonly hovercard = new PortaledHovercardController(
    () => this.close(true),
    CLOSE_DELAY_MS,
    () => this.close(),
  );
  private loadGeneration = 0;
  private readonly activeTargetObserver = new MutationObserver(() => {
    if (
      this.activeTarget &&
      (!this.host.contains(this.activeTarget) || sessionHovercardMenuOpen(this.host))
    ) {
      this.close();
      return;
    }
    if (this.open) {
      this.showCurrent();
    }
  });

  get client(): GatewayBrowserClient | null {
    return this.applicationClient;
  }

  set client(value: GatewayBrowserClient | null) {
    if (value === this.applicationClient) {
      return;
    }
    this.applicationClient = value;
    this.sessionLinkTitler.client = value;
    if (this.host.isConnected) {
      this.sessionLinkTitler.refresh();
    }
  }

  get context(): ApplicationContext | null {
    return this.applicationContext;
  }

  set context(value: ApplicationContext | null) {
    if (value === this.applicationContext) {
      return;
    }
    this.stopContextUpdates?.();
    this.stopContextUpdates = null;
    this.applicationContext = value;
    this.sessionLinkTitler.context = value;
    if (this.host.isConnected) {
      this.sessionLinkTitler.refresh();
      this.connectStore();
    }
  }

  get gateway(): ApplicationGateway | null {
    return this.applicationGateway;
  }

  set gateway(value: ApplicationGateway | null) {
    if (value === this.applicationGateway) {
      return;
    }
    this.disconnectStore();
    this.applicationGateway = value;
    this.close();
    if (this.host.isConnected) {
      this.connectStore();
    }
  }

  connect(): void {
    this.host.style.display = "contents";
    this.host.addEventListener("pointerover", this.handlePointerOver);
    this.host.addEventListener("pointerout", this.handlePointerOut);
    this.host.addEventListener("focusin", this.handleFocusIn);
    this.host.addEventListener("focusout", this.handleFocusOut);
    this.host.addEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.host.addEventListener("click", this.handleClick);
    this.host.addEventListener(SESSION_MENU_OPEN_EVENT, this.handleSessionMenuOpen);
    this.sessionLinkTitler.connect();
    this.connectStore();
  }

  disconnect(): void {
    this.host.removeEventListener("pointerover", this.handlePointerOver);
    this.host.removeEventListener("pointerout", this.handlePointerOut);
    this.host.removeEventListener("focusin", this.handleFocusIn);
    this.host.removeEventListener("focusout", this.handleFocusOut);
    this.host.removeEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.host.removeEventListener("click", this.handleClick);
    this.host.removeEventListener(SESSION_MENU_OPEN_EVENT, this.handleSessionMenuOpen);
    this.sessionLinkTitler.disconnect();
    this.disconnectStore();
    this.close();
    this.clearSkipDelayTimer();
  }

  private connectStore(): void {
    if (this.applicationContext && !this.stopContextUpdates) {
      const stopSessions = this.applicationContext.sessions.subscribe(this.handleSessionUpdate);
      // A retained global row can keep the same DOM/key while its selected owner changes.
      const stopSelection = this.applicationContext.agentSelection.subscribe(() => this.close());
      this.stopContextUpdates = () => {
        stopSessions();
        stopSelection();
      };
    }
    if (!this.applicationGateway || this.progressCards) {
      return;
    }
    this.progressCards = sessionProgressCardsForGateway(this.applicationGateway);
    this.stopProgressCardUpdates = this.progressCards.subscribe(this.handleCardUpdate);
  }

  private disconnectStore(): void {
    this.progressCards?.unwatch(this);
    this.stopProgressCardUpdates?.();
    this.stopProgressCardUpdates = null;
    this.stopContextUpdates?.();
    this.stopContextUpdates = null;
    this.progressCards = null;
    this.releasePullRequestStore();
  }

  private readonly handleSessionUpdate = () => {
    this.sessionLinkTitler.refresh();
    this.handleCardUpdate();
  };

  private readonly handleCardUpdate = () => {
    if (this.open && this.hovercard.held) {
      this.showCurrent();
    }
  };

  private readonly handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !globalThis.matchMedia?.("(hover: hover)").matches) {
      return;
    }
    const target = sessionProgressHoverTargetFromEvent(event);
    if (!target || sessionHovercardMenuOpen(this.host)) {
      return;
    }
    const delayed = this.delayed;
    this.activate(target, target, delayed ? OPEN_DELAY_MS : SWEEP_OPEN_DELAY_MS, delayed);
    this.hovercard.pointerInside = true;
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const target = sessionProgressHoverTargetFromEvent(event);
    if (!target || target !== this.activeTarget) {
      return;
    }
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.schedulePointerExit();
  };

  private readonly handleFocusIn = (event: FocusEvent) => {
    if (this.hovercard.restoringFocus) {
      return;
    }
    const target = sessionProgressHoverTargetFromEvent(event);
    const focused = event.target instanceof HTMLElement ? event.target : null;
    const trigger = target?.matches(".sidebar-recent-session")
      ? focused?.closest<HTMLElement>("a.sidebar-recent-session__link")
      : focused;
    if (!target || !trigger || sessionHovercardMenuOpen(this.host)) {
      return;
    }
    this.activate(target, trigger, 0, false);
    this.hovercard.focusInside = true;
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeTarget) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeTarget.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.focusInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleClick = (event: Event) => {
    if (sessionProgressHoverTargetFromEvent(event)) {
      this.close();
    }
  };

  private readonly handleSessionMenuOpen = () => {
    this.close();
  };

  private activate(
    target: HTMLElement,
    trigger: HTMLElement,
    delay: number,
    animateEntry: boolean,
  ): void {
    const sessionKey = target.dataset.sessionKey;
    if (!sessionKey) {
      return;
    }
    const agentId =
      parseAgentSessionKey(sessionKey)?.agentId ??
      target.closest<AppSidebarSessionNavigationElement>("openclaw-app-sidebar")?.expandedAgentId();
    if (!agentId) {
      return;
    }
    const artifactKey = scopedSessionArtifactKey(sessionKey, agentId);
    if (
      target === this.activeTarget &&
      sessionKey === this.activeSession?.sessionKey &&
      artifactKey === this.activeArtifactKey
    ) {
      if (trigger !== this.activeTrigger) {
        this.hovercard.reset();
        this.activeTrigger = trigger;
        this.hovercard.markTrigger(trigger);
        if (this.open) {
          this.showCurrent();
        } else {
          this.animateNextOpen = animateEntry;
          const generation = ++this.loadGeneration;
          this.hovercard.scheduleOpen(delay, () => void this.loadAndShow(sessionKey, generation));
        }
      }
      return;
    }
    this.close(delay > 0);
    this.activeTarget = target;
    this.activeTrigger = trigger;
    this.activeSession = { sessionKey, agentId };
    this.open = false;
    this.animateNextOpen = animateEntry;
    this.lastProgressCard = null;
    this.progressCards?.watch(this, [this.activeSession]);
    this.hovercard.markTrigger(trigger);
    this.activeTargetObserver.observe(this.host, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
      childList: true,
      subtree: true,
    });
    const generation = ++this.loadGeneration;
    this.hovercard.scheduleOpen(delay, () => void this.loadAndShow(sessionKey, generation));
  }

  private async loadAndShow(sessionKey: string, generation: number): Promise<void> {
    const target = this.activeTarget;
    const artifactKey = this.activeArtifactKey;
    const session = this.activeSession;
    if (target instanceof HTMLAnchorElement && target.dataset.sessionKey === sessionKey) {
      void this.sessionLinkTitler.decorate(target, true);
    }
    if (
      generation !== this.loadGeneration ||
      session?.sessionKey !== sessionKey ||
      !artifactKey ||
      !session ||
      !target ||
      sessionHovercardMenuOpen(this.host) ||
      !this.hovercard.held
    ) {
      return;
    }
    this.open = true;
    this.delayed = false;
    this.clearSkipDelayTimer();
    this.watchPullRequests(artifactKey);
    this.showCurrent();
    try {
      await this.progressCards?.load(session);
    } catch {
      // Session facts and the last successful card remain useful when refresh fails.
    }
    if (
      generation === this.loadGeneration &&
      this.activeSession?.sessionKey === sessionKey &&
      this.hovercard.held
    ) {
      this.showCurrent();
    }
  }

  private watchPullRequests(sessionKey: string): void {
    const gateway = this.applicationGateway;
    if (!gateway) {
      return;
    }
    this.releasePullRequestStore();
    this.pullRequests = sessionPullRequestsForGateway(gateway);
    this.stopPullRequestUpdates = this.pullRequests.subscribe(this.handleCardUpdate);
    this.pullRequests.watch(this, [sessionKey], { foreground: true });
  }

  private releasePullRequestStore(): void {
    this.pullRequests?.unwatch(this);
    this.stopPullRequestUpdates?.();
    this.stopPullRequestUpdates = null;
    this.pullRequests = null;
  }

  private showCurrent(): void {
    const target = this.activeTarget;
    const session = this.activeSession;
    const sessionKey = session?.sessionKey;
    const artifactKey = this.activeArtifactKey;
    if (!target || !session || !sessionKey || !artifactKey || !this.open) {
      return;
    }
    const sidebarRow = this.host
      .querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar")
      ?.findSidebarHovercardRowByKey(sessionKey);
    const pullRequests = this.pullRequests?.get(artifactKey);
    const currentProgressCard = this.progressCards?.get(session);
    if (currentProgressCard !== undefined) {
      this.lastProgressCard = currentProgressCard;
    }
    const gateway = this.applicationGateway;
    const channelAvatarAuth = resolveControlUiAvatarAuth({
      hello: gateway?.snapshot.hello,
      settings: gateway?.connection,
      password: gateway?.connection.password,
    });
    const revision = JSON.stringify({
      progress: this.lastProgressCard?.revision ?? null,
      pullRequests: pullRequests
        ? {
            branch: pullRequests.branch,
            pullRequests: pullRequests.pullRequests,
            status: pullRequests.status,
          }
        : null,
      row: sidebarRow
        ? {
            label: sidebarRow.label,
            color: sidebarRow.color,
            attention: sidebarRow.attention,
            boardFace: sidebarRow.boardFace,
            hasAutomation: sidebarRow.hasAutomation,
            hasActiveRun: sidebarRow.hasActiveRun,
            channelAvatarUrl: sidebarRow.channelAvatarUrl,
            channelPresentation: sidebarRow.channelPresentation,
            lastMessagePreview: sidebarRow.lastMessagePreview,
            createdActor: sidebarRow.createdActor,
            participants: sidebarRow.participants,
            expandedParticipants: sidebarRow.expandedParticipants,
            participantCount: sidebarRow.participantCount,
            workContext: sidebarRow.workContext,
            placementMachine: sidebarRow.placementMachine,
            createdAt: sidebarRow.createdAt,
            startedAt: sidebarRow.startedAt,
            updatedAt: sidebarRow.updatedAt,
            status: sidebarRow.status,
            endedAt: sidebarRow.endedAt,
          }
        : null,
    });
    if (this.hovercard.card?.dataset.revision === revision) {
      return;
    }
    const mountedCard = this.hovercard.card;
    const focusedCardElement =
      mountedCard?.contains(document.activeElement) && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusedCardIndex = focusedCardElement
      ? this.hovercard.focusables().indexOf(focusedCardElement)
      : -1;
    const focusedHref =
      focusedCardElement instanceof HTMLAnchorElement ? focusedCardElement.href : null;
    const animateEntry = !mountedCard && this.animateNextOpen;
    let card = mountedCard;
    if (!card) {
      nextHovercardId += 1;
      card = createPortaledHovercard(
        `openclaw-session-progress-hovercard-${nextHovercardId}`,
        "session-progress-hovercard",
      );
      this.animateNextOpen = false;
      if (animateEntry) {
        card.dataset.open = "false";
      } else {
        card.dataset.instant = "true";
      }
    }
    card.dataset.revision = revision;
    card.setAttribute("aria-label", t("sessionHovercard.ariaLabel"));
    const input: SessionHovercardInput = {
      row: sidebarRow,
      selfUserId: this.applicationContext?.gateway.snapshot.selfUser?.id,
      avatarAuth: channelAvatarAuth,
      personActivity: this.personActivity(),
      automationLink: this.applicationContext
        ? {
            href: `${pathForRoute("cron", this.applicationContext.basePath)}?${new URLSearchParams({ session: sessionKey, agent: session.agentId! })}`,
            navigate: () => {
              const context = this.applicationContext;
              this.close();
              context?.navigate("cron", {
                search: `?${new URLSearchParams({ session: sessionKey, agent: session.agentId! })}`,
              });
            },
          }
        : undefined,
      pullRequests,
      progressCard: this.lastProgressCard,
    };
    const afterCommit = () => {
      if (this.hovercard.card !== card) {
        return;
      }
      if (!card.firstElementChild) {
        this.hovercard.clearCard();
        this.hovercard.pointerOverCard = false;
        this.hovercard.cardFocusInside = false;
        return;
      }
      if (mountedCard) {
        if (focusedCardElement && !card.contains(document.activeElement)) {
          const focusables = this.hovercard.focusables();
          const nextFocused =
            (focusedHref
              ? focusables.find(
                  (element) => element instanceof HTMLAnchorElement && element.href === focusedHref,
                )
              : undefined) ?? focusables[focusedCardIndex];
          if (nextFocused) {
            nextFocused.focus({ preventScroll: true });
          } else {
            this.hovercard.cardFocusInside = false;
            this.hovercard.returnFocus(this.activeTrigger);
            this.hovercard.focusInside = document.activeElement === this.activeTrigger;
          }
        }
        this.hovercard.position();
        return;
      }
      this.hovercard.position();
    };
    if (mountedCard) {
      this.cardUpdates.get(mountedCard)?.(input, afterCommit);
      return;
    }
    card.addEventListener("pointerleave", this.hovercard.handleCardPointerLeave);
    const dispose = runWithOwner(null, () =>
      render(() => {
        const [snapshot, setSnapshot] = createSignal({ input, afterCommit });
        this.cardUpdates.set(card, (next, committed) =>
          setSnapshot({ input: next, afterCommit: committed }),
        );
        createEffect(
          () => snapshot(),
          (value) => onSettled(value.afterCommit),
        );
        return <SessionHovercard {...snapshot().input} />;
      }, card),
    );
    // Render before mounting: rich children can settle inside their own bridge roots.
    if (!card.firstElementChild) {
      this.cardUpdates.delete(card);
      dispose();
      return;
    }
    this.hovercard.mount(
      target,
      card,
      sessionProgressHoverPlacementForTarget(target),
      false,
      () => {
        this.cardUpdates.delete(card);
        dispose();
      },
    );
    if (this.hovercard.card !== card) {
      return;
    }
    if (animateEntry) {
      void card.offsetWidth;
      window.setTimeout(() => {
        if (this.hovercard.card === card && this.open) {
          card.dataset.open = "true";
        }
      }, 0);
    }
  }

  private personActivity(): PersonActivityRouting | undefined {
    const context = this.applicationContext;
    // The card outlives its trigger row after navigation, so close it on the way out.
    return context ? personActivityRouting(context, () => this.close()) : undefined;
  }

  private close(animateExit = false): void {
    const wasOpen = this.open;
    this.hovercard.reset(animateExit ? EXIT_DURATION_MS : 0);
    this.loadGeneration += 1;
    this.open = false;
    this.animateNextOpen = true;
    this.lastProgressCard = null;
    this.activeTargetObserver.disconnect();
    this.progressCards?.unwatch(this);
    this.releasePullRequestStore();
    this.activeTarget = null;
    this.activeTrigger = null;
    this.activeSession = null;
    if (wasOpen) {
      this.clearSkipDelayTimer();
      this.skipDelayTimer = window.setTimeout(() => {
        this.skipDelayTimer = null;
        this.delayed = true;
      }, SKIP_DELAY_MS);
    }
  }

  private clearSkipDelayTimer(): void {
    if (this.skipDelayTimer !== null) {
      window.clearTimeout(this.skipDelayTimer);
      this.skipDelayTimer = null;
    }
  }
}

export const SessionProgressHovercard = defineSolidBridge<SessionProgressHovercardProps>(
  "openclaw-session-progress-hovercard-provider",
  (props, host) => {
    const controller = new SessionProgressHovercardController(host);
    createEffect(
      () => [props.client, props.context, props.gateway] as const,
      ([client, context, gateway]) => {
        controller.client = client;
        controller.context = context;
        controller.gateway = gateway;
      },
    );
    onSettled(() => controller.connect());
    onCleanup(() => controller.disconnect());
    return props.children;
  },
  {
    properties: {
      client: { default: null, attribute: false },
      context: { default: null, attribute: false },
      gateway: { default: null, attribute: false },
    },
  },
);
