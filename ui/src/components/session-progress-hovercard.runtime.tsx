import "../styles/session-progress-hovercard.css";
import type { ProgressCard, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { render, spread } from "@solidjs/web";
import { createMemo, onSettled, runWithOwner, Show } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { resolveControlUiAvatarAuth } from "../app/control-ui-auth.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { listen } from "../lib/reactive/listener.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { createTimeout } from "../lib/reactive/timers.ts";
import {
  sessionProgressCardsForGateway,
  type SessionProgressCardStore,
} from "../lib/session-progress-cards.ts";
import {
  sessionPullRequestsForGateway,
  type SessionPullRequestSnapshotStore,
} from "../lib/session-pull-requests.ts";
import { parseAgentSessionKey, scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { AppSidebarElement, AppSidebarMethods } from "./app-sidebar.tsx";
import type { SessionTitleDisplay } from "./markdown-link-display.ts";
import { registryFor } from "./overlay-registry.ts";
import { personActivityRouting } from "./person-activity-link.ts";
import { controlsForHovercard, HovercardControlsContext } from "./portaled-hovercard-focus.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "./portaled-hovercard.ts";
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

function sessionHovercardMenuOpen(owner: HTMLElement): boolean {
  return [...registryFor(owner.ownerDocument).members.keys()].some(
    (overlay) =>
      overlay.open &&
      owner.contains(overlay.surface) &&
      overlay.surface.closest("openclaw-session-menu, openclaw-catalog-session-menu") !== null,
  );
}

type SessionProgressHovercardProps = {
  client: GatewayBrowserClient | null;
  context: ApplicationContext | null;
  gateway: ApplicationGateway | null;
  lookupSidebarRow: AppSidebarMethods["findSidebarHovercardRowByKey"] | null;
};

type SessionProgressHovercardMethods = {
  registerSessionTitleTarget: (
    target: HTMLElement,
    label: HTMLElement,
    display?: SessionTitleDisplay,
  ) => () => void;
};

type HovercardFrame = {
  revision: string;
  input: SessionHovercardInput;
  commit: (card: HTMLDivElement) => void;
};

export type SessionProgressHovercardProvider = SolidBridgeElement<
  SessionProgressHovercardProps,
  SessionProgressHovercardMethods
>;
const sessionLinkTitlers = new WeakMap<HTMLElement, SessionLinkTitler>();

function createSessionProgressHovercard(
  props: SessionProgressHovercardProps,
  host: SessionProgressHovercardProvider,
) {
  const sessionLinkTitler = sessionLinkTitlers.get(host) ?? new SessionLinkTitler();
  sessionLinkTitlers.set(host, sessionLinkTitler);
  const applicationContext = createMemo(() => props.context);
  const applicationGateway = createMemo(() => props.gateway);
  const watchOwner = {};

  let progressCards: SessionProgressCardStore | null = null;
  let pullRequestStore: SessionPullRequestSnapshotStore | null = null;
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
  const skipDelay = createTimeout(() => {
    delayed = true;
  }, SKIP_DELAY_MS);
  let lastProgressCard: ProgressCard | null = null;
  let gatewaySnapshotRevision = 0;
  let renderedRevision: string | null = null;
  let current: HovercardFrame | undefined;
  let refreshCurrent = () => {};
  const hovercard = createPortaledHovercardOwner(
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
        current = undefined;
        activeTrigger = trigger;
        hovercard.markTrigger(trigger);
        if (open) {
          showCurrent();
        } else {
          animateNextOpen = animateEntry;
          hovercard.scheduleOpen(delay, () => loadAndShow(sessionKey));
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
    hovercard.scheduleOpen(delay, () => loadAndShow(sessionKey));
  }

  function loadAndShow(sessionKey: string): void {
    const target = activeTarget;
    const artifactKey = activeArtifactKey();
    const session = activeSession;
    if (target instanceof HTMLAnchorElement && target.dataset.sessionKey === sessionKey) {
      void sessionLinkTitler.decorate(target);
    }
    if (
      session?.sessionKey !== sessionKey ||
      !artifactKey ||
      !target ||
      sessionHovercardMenuOpen(host) ||
      !hovercard.held
    ) {
      return;
    }
    open = true;
    delayed = false;
    skipDelay.cancel();
    const gateway = applicationGateway();
    if (gateway) {
      pullRequestStore = sessionPullRequestsForGateway(gateway);
      projection.replaceSource(readSources());
      pullRequestStore.watch(watchOwner, [artifactKey], { foreground: true });
    }
    showCurrent();
    // The projection receives both successful loads and failures; keep the last useful card.
    void progressCards?.load(session).catch(() => {});
  }

  function readCurrent(force = false): HovercardFrame | undefined {
    const session = activeSession;
    const sessionKey = session?.sessionKey;
    const artifactKey = activeArtifactKey();
    if (!activeTarget || !session || !sessionKey || !artifactKey || !open) {
      return undefined;
    }
    if (!force && !hovercard.held) {
      return current;
    }
    const sidebarRow = host.lookupSidebarRow?.(sessionKey);
    const pullRequests = pullRequestStore?.get(artifactKey);
    const currentProgressCard = progressCards?.get(session);
    if (currentProgressCard !== undefined) {
      lastProgressCard = currentProgressCard;
    }
    const gateway = applicationGateway();
    const revision = JSON.stringify({
      gateway: gatewaySnapshotRevision,
      progress: lastProgressCard?.revision ?? null,
      pullRequests: pullRequests
        ? {
            branch: pullRequests.branch,
            pullRequests: pullRequests.pullRequests,
            taskPullRequests: pullRequests.taskPullRequests,
            taskPullRequestCount: pullRequests.taskPullRequestCount,
            pullRequestCount: pullRequests.pullRequestCount,
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
            gatewayHasActiveRun: sidebarRow.gatewayHasActiveRun,
            hasActiveSubagentRun: sidebarRow.hasActiveSubagentRun,
            lastRunError: sidebarRow.lastRunError,
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
    if (current?.revision === revision) {
      return current;
    }
    const focusedCardElement =
      hovercard.card?.contains(document.activeElement) &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusedCardIndex = focusedCardElement
      ? hovercard.focusables().indexOf(focusedCardElement)
      : -1;
    const focusedHref =
      focusedCardElement instanceof HTMLAnchorElement ? focusedCardElement.href : null;
    const currentContext = applicationContext();
    const input: SessionHovercardInput = {
      row: sidebarRow,
      connected: gateway?.snapshot.phase === "connected",
      selfUserId: currentContext?.gateway.snapshot.selfUser?.id,
      avatarAuth: resolveControlUiAvatarAuth({
        hello: gateway?.snapshot.hello,
        settings: gateway?.connection,
        password: gateway?.connection.password,
      }),
      // The card can outlive its row after navigation.
      personActivity: currentContext
        ? personActivityRouting(currentContext, () => close())
        : undefined,
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
    const commit = (card: HTMLDivElement) => {
      if (hovercard.card !== card) {
        return;
      }
      if (!card.firstElementChild) {
        hovercard.clearCard();
        hovercard.pointerOverCard = false;
        hovercard.cardFocusInside = false;
        return;
      }
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
    };
    return (current = { revision, input, commit });
  }

  function showCurrent(): void {
    const next = readCurrent(true);
    // Empty renders retire their portal; retain the revision so our trigger mutation
    // cannot remount the same empty input in a MutationObserver loop.
    if (!next || renderedRevision === next.revision) {
      return;
    }
    refreshCurrent();
    renderedRevision = next.revision;
    if (hovercard.card || !activeTarget) {
      return;
    }
    const target = activeTarget;
    const animateEntry = animateNextOpen;
    const card = createPortaledHovercard(
      `openclaw-session-progress-hovercard-${++nextHovercardId}`,
      "session-progress-hovercard",
    );
    const isCurrentCard = () => hovercard.card === card;
    animateNextOpen = false;
    if (animateEntry) {
      card.dataset.open = "false";
    } else {
      card.dataset.instant = "true";
    }
    const stopPointerLeave = listen(card, "pointerleave", hovercard.handleCardPointerLeave);
    let dispose: (() => void) | undefined = undefined;
    hovercard.mount(target, card, sessionProgressHoverPlacementForTarget(target), false, () => {
      stopPointerLeave();
      dispose?.();
    });
    if (!isCurrentCard()) {
      return;
    }
    dispose = runWithOwner(null, () =>
      render(() => {
        let pending: typeof next | undefined;
        const read = createMemo<HovercardFrame>((previous = next) =>
          isCurrentCard() ? (projection.read() ?? previous) : previous,
        );
        const commit = () => {
          const frame = pending;
          pending = undefined;
          frame?.commit(card);
        };
        spread(
          card,
          () => {
            const frame = read();
            pending = frame;
            renderedRevision = frame.revision;
            // A second settle follows the Markdown islands' DOM-writing effects.
            onSettled(() => onSettled(commit));
            return { "aria-label": t("sessionHovercard.ariaLabel") };
          },
          true,
        );
        return (
          <HovercardControlsContext value={controlsForHovercard(card)}>
            <SessionHovercard {...read().input} />
          </HovercardControlsContext>
        );
      }, card),
    );
    // An empty initial render can retire its portal before render() returns its disposer.
    if (!isCurrentCard()) {
      dispose?.();
    }
    if (animateEntry) {
      void card.offsetWidth;
      window.setTimeout(() => {
        if (isCurrentCard() && open) {
          card.dataset.open = "true";
        }
      }, 0);
    }
  }

  function close(animateExit = false): void {
    const wasOpen = open;
    hovercard.reset(animateExit ? EXIT_DURATION_MS : 0);
    open = false;
    animateNextOpen = true;
    lastProgressCard = null;
    renderedRevision = null;
    current = undefined;
    activeTargetObserver.disconnect();
    progressCards?.unwatch(watchOwner);
    pullRequestStore?.unwatch(watchOwner);
    pullRequestStore = null;
    projection.replaceSource(readSources());
    activeTarget = null;
    activeTrigger = null;
    activeSession = null;
    if (wasOpen) {
      skipDelay.schedule();
    }
  }

  const readSources = () => ({
    context: applicationContext(),
    gateway: applicationGateway(),
    progressCards,
    pullRequestStore,
  });
  const projection = projectSource<ReturnType<typeof readSources>, HovercardFrame | undefined>(
    { context: null, gateway: null, progressCards: null, pullRequestStore: null },
    {
      read: () => readCurrent(),
      subscribe: (sources, notify) => {
        refreshCurrent = notify;
        const stops = [
          sources.gateway?.subscribe(() => {
            gatewaySnapshotRevision += 1;
            notify();
          }),
          sources.context?.sessions.subscribe(notify),
          sources.progressCards?.subscribe(notify),
          sources.pullRequestStore?.subscribe(notify),
        ];
        return () => stops.forEach((stop) => stop?.());
      },
      equality: "revision",
    },
  );
  const titlerSource = createMemo(() => ({ client: props.client, context: applicationContext() }), {
    equals: (previous, next) =>
      previous.client === next.client && previous.context === next.context,
  });
  onSettled(() => {
    host.style.display = "contents";
    const stops = [
      listen(host, "pointerover", { handleEvent: handlePointerOver }),
      listen(host, "pointerout", { handleEvent: handlePointerOut }),
      listen(host, "focusin", { handleEvent: handleFocusIn }),
      listen(host, "focusout", { handleEvent: handleFocusOut }),
      listen(host, "keydown", { handleEvent: hovercard.handleTriggerKeyDown }),
      listen(host, "click", (event) => {
        if (sessionProgressHoverTargetFromEvent(event)) {
          close();
        }
      }),
      listen(host, SESSION_MENU_OPEN_EVENT, () => close()),
    ];
    return () => {
      stops.forEach((stop) => stop());
      sessionLinkTitler.disconnect();
      close();
      skipDelay.cancel();
    };
  });
  return (
    <>
      <Show when={projection.read()} keyed>
        {(_frame) => {
          onSettled(() => {
            if (open && hovercard.held && !hovercard.card) {
              showCurrent();
            }
          });
          return null;
        }}
      </Show>
      <Show when={titlerSource()} keyed>
        {(source) => {
          onSettled(() => {
            const context = source.context;
            sessionLinkTitler.client = source.client;
            sessionLinkTitler.context = context;
            if (host.isConnected) {
              sessionLinkTitler.refresh();
            }
            projection.replaceSource(readSources());
            // The title owner decorates retained Markdown links even when no card is open.
            const stopTitles = context?.sessions.subscribe(() => sessionLinkTitler.refresh());
            // A retained global row can keep its DOM/key while its selected owner changes.
            const stopSelection = context?.agentSelection.subscribe(() => close());
            return () => {
              stopTitles?.();
              stopSelection?.();
            };
          });
          return null;
        }}
      </Show>
      <Show when={applicationGateway()} keyed>
        {(gateway) => {
          onSettled(() => {
            close();
            progressCards = sessionProgressCardsForGateway(gateway);
            // Provider-lifetime custody keeps cached cards when the projection reconnects.
            const stopCache = progressCards.subscribe(() => {});
            projection.replaceSource(readSources());
            return () => {
              close();
              stopCache();
              progressCards = null;
              projection.replaceSource(readSources());
            };
          });
          return null;
        }}
      </Show>
    </>
  );
}

export const SessionProgressHovercard = defineSolidBridge<
  SessionProgressHovercardProps,
  SessionProgressHovercardMethods
>(
  "openclaw-session-progress-hovercard-provider",
  (props, host) => {
    const bindings = createSessionProgressHovercard(props, host);
    return (
      <>
        {bindings}
        {props.children}
      </>
    );
  },
  {
    properties: {
      client: { default: null, attribute: false },
      context: { default: null, attribute: false },
      gateway: { default: null, attribute: false },
      lookupSidebarRow: { default: null, attribute: false },
    },
    methods: {
      registerSessionTitleTarget: (host, target, label, display) =>
        sessionLinkTitlers.get(host)?.register(target, label, display) ?? (() => {}),
    },
  },
);
