import type { ProgressCard, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { render } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onSettled, runWithOwner } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { resolveControlUiAvatarAuth } from "../app/control-ui-auth.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { listen } from "../lib/reactive/listener.ts";
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
import type { AppSidebarElement } from "./app-sidebar.tsx";
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

function createSessionProgressHovercard(props: SessionProgressHovercardProps, host: HTMLElement) {
  const sessionLinkTitler = new SessionLinkTitler(host);
  const applicationContext = createMemo(() => props.context);
  const applicationGateway = createMemo(() => props.gateway);
  const [ready, setReady] = createSignal(false);
  const watchOwner = {};

  const cardUpdates = new WeakMap<
    HTMLDivElement,
    (input: SessionHovercardInput, afterCommit: () => void) => void
  >();

  let progressCards: SessionProgressCardStore | null = null;
  let pullRequestStore: SessionPullRequestSnapshotStore | null = null;
  let stopPullRequestUpdates: (() => void) | null = null;
  let activeTarget: HTMLElement | null = null;
  let activeTrigger: HTMLElement | null = null;
  let activeSession: ProgressCardGetParams | null = null;

  function activeArtifactKey(): string | null {
    return activeSession
      ? scopedSessionArtifactKey(activeSession.sessionKey, activeSession.agentId)
      : null;
  }
  // Hover/focus admission must be visible within the same event turn.
  let open = false;
  let delayed = true;
  let animateNextOpen = true;
  let skipDelayTimer: number | null = null;
  let lastProgressCard: ProgressCard | null = null;
  let renderedRevision: string | null = null;
  const hovercard = new PortaledHovercardController(
    () => close(true),
    CLOSE_DELAY_MS,
    () => close(),
  );
  const activeTargetObserver = new MutationObserver(() => {
    if (activeTarget && (!host.contains(activeTarget) || sessionHovercardMenuOpen(host))) {
      close();
      return;
    }
    if (open) {
      showCurrent();
    }
  });

  const handleSessionUpdate = () => {
    sessionLinkTitler.refresh();
    handleCardUpdate();
  };

  const handleCardUpdate = () => {
    if (open && hovercard.held) {
      showCurrent();
    }
  };

  const handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !globalThis.matchMedia?.("(hover: hover)").matches) {
      return;
    }
    const target = sessionProgressHoverTargetFromEvent(event);
    if (!target || sessionHovercardMenuOpen(host)) {
      return;
    }
    activate(target, target, delayed ? OPEN_DELAY_MS : SWEEP_OPEN_DELAY_MS, delayed);
    hovercard.pointerInside = true;
  };

  const handlePointerOut = (event: PointerEvent) => {
    const target = sessionProgressHoverTargetFromEvent(event);
    if (!target || target !== activeTarget) {
      return;
    }
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) {
      return;
    }
    hovercard.schedulePointerExit();
  };

  const handleFocusIn = (event: FocusEvent) => {
    if (hovercard.restoringFocus) {
      return;
    }
    const target = sessionProgressHoverTargetFromEvent(event);
    const focused = event.target instanceof HTMLElement ? event.target : null;
    const trigger = target?.matches(".sidebar-recent-session")
      ? focused?.closest<HTMLElement>("a.sidebar-recent-session__link")
      : focused;
    if (!target || !trigger || sessionHovercardMenuOpen(host)) {
      return;
    }
    activate(target, trigger, 0, false);
    hovercard.focusInside = true;
  };

  const handleFocusOut = (event: FocusEvent) => {
    if (!activeTarget) {
      return;
    }
    if (event.relatedTarget instanceof Node && activeTarget.contains(event.relatedTarget)) {
      return;
    }
    hovercard.focusInside = false;
    hovercard.scheduleClose();
  };

  const handleClick = (event: Event) => {
    if (sessionProgressHoverTargetFromEvent(event)) {
      close();
    }
  };

  const handleSessionMenuOpen = () => {
    close();
  };

  function activate(
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
      target.closest<AppSidebarElement>("openclaw-app-sidebar")?.expandedAgentId();
    if (!agentId) {
      return;
    }
    const artifactKey = scopedSessionArtifactKey(sessionKey, agentId);
    if (
      target === activeTarget &&
      sessionKey === activeSession?.sessionKey &&
      artifactKey === activeArtifactKey()
    ) {
      if (trigger !== activeTrigger) {
        hovercard.reset();
        renderedRevision = null;
        activeTrigger = trigger;
        hovercard.markTrigger(trigger);
        if (open) {
          showCurrent();
        } else {
          animateNextOpen = animateEntry;
          hovercard.scheduleOpen(delay, () => void loadAndShow(sessionKey));
        }
      }
      return;
    }
    close(delay > 0);
    activeTarget = target;
    activeTrigger = trigger;
    activeSession = { sessionKey, agentId };
    open = false;
    animateNextOpen = animateEntry;
    lastProgressCard = null;
    progressCards?.watch(watchOwner, [activeSession]);
    hovercard.markTrigger(trigger);
    activeTargetObserver.observe(host, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
      childList: true,
      subtree: true,
    });
    hovercard.scheduleOpen(delay, () => void loadAndShow(sessionKey));
  }

  async function loadAndShow(sessionKey: string): Promise<void> {
    const target = activeTarget;
    const artifactKey = activeArtifactKey();
    const session = activeSession;
    if (target instanceof HTMLAnchorElement && target.dataset.sessionKey === sessionKey) {
      void sessionLinkTitler.decorate(target, true);
    }
    if (
      session?.sessionKey !== sessionKey ||
      !artifactKey ||
      !session ||
      !target ||
      sessionHovercardMenuOpen(host) ||
      !hovercard.held
    ) {
      return;
    }
    open = true;
    delayed = false;
    clearSkipDelayTimer();
    watchPullRequests(artifactKey);
    showCurrent();
    try {
      await progressCards?.load(session);
    } catch {
      // Session facts and the last successful card remain useful when refresh fails.
    }
    if (activeSession?.sessionKey === sessionKey && hovercard.held) {
      showCurrent();
    }
  }

  function watchPullRequests(sessionKey: string): void {
    const gateway = applicationGateway();
    if (!gateway) {
      return;
    }
    releasePullRequestStore();
    pullRequestStore = sessionPullRequestsForGateway(gateway);
    stopPullRequestUpdates = pullRequestStore.subscribe(handleCardUpdate);
    pullRequestStore.watch(watchOwner, [sessionKey], { foreground: true });
  }

  function releasePullRequestStore(): void {
    pullRequestStore?.unwatch(watchOwner);
    stopPullRequestUpdates?.();
    stopPullRequestUpdates = null;
    pullRequestStore = null;
  }

  function showCurrent(): void {
    const target = activeTarget;
    const session = activeSession;
    const sessionKey = session?.sessionKey;
    const artifactKey = activeArtifactKey();
    if (!target || !session || !sessionKey || !artifactKey || !open) {
      return;
    }
    const sidebarRow = host
      .querySelector<AppSidebarElement>("openclaw-app-sidebar")
      ?.findSidebarHovercardRowByKey(sessionKey);
    const pullRequests = pullRequestStore?.get(artifactKey);
    const currentProgressCard = progressCards?.get(session);
    if (currentProgressCard !== undefined) {
      lastProgressCard = currentProgressCard;
    }
    const gateway = applicationGateway();
    const channelAvatarAuth = resolveControlUiAvatarAuth({
      hello: gateway?.snapshot.hello,
      settings: gateway?.connection,
      password: gateway?.connection.password,
    });
    const revision = JSON.stringify({
      progress: lastProgressCard?.revision ?? null,
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
    // Empty renders retire their portal; retain the revision so our trigger mutation
    // cannot remount the same empty input in a MutationObserver loop.
    if (renderedRevision === revision) {
      return;
    }
    renderedRevision = revision;
    const mountedCard = hovercard.card;
    const focusedCardElement =
      mountedCard?.contains(document.activeElement) && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusedCardIndex = focusedCardElement
      ? hovercard.focusables().indexOf(focusedCardElement)
      : -1;
    const focusedHref =
      focusedCardElement instanceof HTMLAnchorElement ? focusedCardElement.href : null;
    const animateEntry = !mountedCard && animateNextOpen;
    let card = mountedCard;
    if (!card) {
      nextHovercardId += 1;
      card = createPortaledHovercard(
        `openclaw-session-progress-hovercard-${nextHovercardId}`,
        "session-progress-hovercard",
      );
      animateNextOpen = false;
      if (animateEntry) {
        card.dataset.open = "false";
      } else {
        card.dataset.instant = "true";
      }
    }
    card.setAttribute("aria-label", t("sessionHovercard.ariaLabel"));
    const currentContext = applicationContext();
    const input: SessionHovercardInput = {
      row: sidebarRow,
      selfUserId: currentContext?.gateway.snapshot.selfUser?.id,
      avatarAuth: channelAvatarAuth,
      personActivity: personActivity(),
      automationLink: currentContext
        ? {
            gateway: applicationGateway(),
            sessionKey,
            agentId: session.agentId!,
            href: `${pathForRoute("cron", currentContext.basePath)}?${new URLSearchParams({ session: sessionKey, agent: session.agentId! })}`,
            navigate: (jobId) => {
              const context = applicationContext();
              const search = new URLSearchParams({ session: sessionKey, agent: session.agentId! });
              if (jobId) {
                search.set("job", jobId);
              }
              close();
              context?.navigate("cron", {
                search: `?${search}`,
              });
            },
          }
        : undefined,
      pullRequests,
      progressCard: lastProgressCard,
    };
    const afterCommit = () => {
      if (hovercard.card !== card) {
        return;
      }
      if (!card.firstElementChild) {
        hovercard.clearCard();
        hovercard.pointerOverCard = false;
        hovercard.cardFocusInside = false;
        return;
      }
      if (mountedCard) {
        if (focusedCardElement && !card.contains(document.activeElement)) {
          const focusables = hovercard.focusables();
          const nextFocused =
            (focusedHref
              ? focusables.find(
                  (element) => element instanceof HTMLAnchorElement && element.href === focusedHref,
                )
              : undefined) ?? focusables[focusedCardIndex];
          if (nextFocused) {
            nextFocused.focus({ preventScroll: true });
          } else {
            hovercard.cardFocusInside = false;
            hovercard.returnFocus(activeTrigger);
            hovercard.focusInside = document.activeElement === activeTrigger;
          }
        }
        hovercard.position();
        return;
      }
      hovercard.position();
    };
    if (mountedCard) {
      cardUpdates.get(mountedCard)?.(input, afterCommit);
      return;
    }
    const stopPointerLeave = listen(card, "pointerleave", hovercard.handleCardPointerLeave);
    let dispose: (() => void) | undefined = undefined;
    let retired = false;
    hovercard.mount(target, card, sessionProgressHoverPlacementForTarget(target), false, () => {
      retired = true;
      stopPointerLeave();
      cardUpdates.delete(card);
      dispose?.();
    });
    if (hovercard.card !== card) {
      return;
    }
    dispose = runWithOwner(null, () =>
      render(() => {
        const [snapshot, setSnapshot] = createSignal({ input, afterCommit });
        cardUpdates.set(card, (next, committed) =>
          setSnapshot({ input: next, afterCommit: committed }),
        );
        createEffect(
          () => snapshot(),
          (value) => onSettled(value.afterCommit),
        );
        return <SessionHovercard {...snapshot().input} />;
      }, card),
    );
    // An empty initial render can retire its portal before render() returns its disposer.
    if (retired) {
      dispose?.();
    }
    if (animateEntry) {
      void card.offsetWidth;
      window.setTimeout(() => {
        if (hovercard.card === card && open) {
          card.dataset.open = "true";
        }
      }, 0);
    }
  }

  function personActivity(): PersonActivityRouting | undefined {
    const context = applicationContext();
    // The card outlives its trigger row after navigation, so close it on the way out.
    return context ? personActivityRouting(context, () => close()) : undefined;
  }

  function close(animateExit = false): void {
    const wasOpen = open;
    hovercard.reset(animateExit ? EXIT_DURATION_MS : 0);
    open = false;
    animateNextOpen = true;
    lastProgressCard = null;
    renderedRevision = null;
    activeTargetObserver.disconnect();
    progressCards?.unwatch(watchOwner);
    releasePullRequestStore();
    activeTarget = null;
    activeTrigger = null;
    activeSession = null;
    if (wasOpen) {
      clearSkipDelayTimer();
      skipDelayTimer = window.setTimeout(() => {
        skipDelayTimer = null;
        delayed = true;
      }, SKIP_DELAY_MS);
    }
  }

  function clearSkipDelayTimer(): void {
    if (skipDelayTimer !== null) {
      window.clearTimeout(skipDelayTimer);
      skipDelayTimer = null;
    }
  }
  createEffect(
    () => [props.client, applicationContext()] as const,
    ([client, context]) => {
      sessionLinkTitler.client = client;
      sessionLinkTitler.context = context;
      if (host.isConnected) {
        sessionLinkTitler.refresh();
      }
    },
  );
  createEffect(
    () => (ready() ? applicationContext() : null),
    (context) => {
      if (!context) {
        return undefined;
      }
      const stopSessions = context.sessions.subscribe(handleSessionUpdate);
      // A retained global row can keep its DOM/key while its selected owner changes.
      const stopSelection = context.agentSelection.subscribe(() => close());
      return () => {
        stopSessions();
        stopSelection();
      };
    },
  );
  createEffect(
    () => (ready() ? applicationGateway() : null),
    (gateway) => {
      close();
      if (!gateway) {
        return undefined;
      }
      const store = sessionProgressCardsForGateway(gateway);
      progressCards = store;
      const stop = store.subscribe(handleCardUpdate);
      return () => {
        close();
        stop();
        progressCards = null;
      };
    },
  );
  onSettled(() => {
    host.style.display = "contents";
    sessionLinkTitler.connect();
    setReady(true);
    const stops = [
      listen(host, "pointerover", { handleEvent: handlePointerOver }),
      listen(host, "pointerout", { handleEvent: handlePointerOut }),
      listen(host, "focusin", { handleEvent: handleFocusIn }),
      listen(host, "focusout", { handleEvent: handleFocusOut }),
      listen(host, "keydown", { handleEvent: hovercard.handleTriggerKeyDown }),
      listen(host, "click", handleClick),
      listen(host, SESSION_MENU_OPEN_EVENT, handleSessionMenuOpen),
    ];
    return () => {
      for (const stop of stops) {
        stop();
      }
      sessionLinkTitler.disconnect();
      close();
      clearSkipDelayTimer();
    };
  });
}

export const SessionProgressHovercard = defineSolidBridge<SessionProgressHovercardProps>(
  "openclaw-session-progress-hovercard-provider",
  (props, host) => {
    createSessionProgressHovercard(props, host);
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
