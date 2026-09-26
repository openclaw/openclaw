import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { RouteId } from "../app-routes.ts";
import { CHAT_ROUTE_READY_EVENT } from "../pages/chat/chat-history-events.ts";
import type { ApplicationContext } from "./context.ts";

type RouteTransitionOptions = {
  document: Document;
  from: RouteId | undefined;
  navigate: () => Promise<void>;
  prefersReducedMotion: boolean;
  router: Pick<ApplicationContext["router"], "getState" | "subscribe">;
  signal?: AbortSignal;
  to: RouteId;
};

const SESSION_ROUTE_ENTER_KEYFRAMES: Keyframe[] = [
  { transform: "translateY(5px) scale(0.997)" },
  { transform: "none" },
];
const SESSION_ROUTE_ENTER_OPTIONS: KeyframeAnimationOptions = {
  duration: 180,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

function waitForChatRouteReady(document: Document) {
  if (document.querySelector(".agent-chat__composer-combobox")) {
    return { cancel: () => undefined, ready: Promise.resolve() };
  }
  const { promise: ready, resolve } = createDeferredCore();
  const handleReady = () => resolve();
  document.addEventListener(CHAT_ROUTE_READY_EVENT, handleReady, { once: true });
  return {
    cancel: () => document.removeEventListener(CHAT_ROUTE_READY_EVENT, handleReady),
    ready,
  };
}

async function navigateAndAnimate(options: RouteTransitionOptions) {
  const { document, navigate, prefersReducedMotion, router, signal, to } = options;
  const outlet = document.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
    "openclaw-router-outlet",
  );
  const chatReady = waitForChatRouteReady(document);
  let canceled = false;
  let animation: Animation | undefined;
  const { promise: cancellation, resolve: resolveCanceled } = createDeferredCore();
  const cancel = () => {
    if (canceled) {
      return;
    }
    canceled = true;
    animation?.cancel();
    resolveCanceled();
  };
  let stop = () => {};
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) {
      return;
    }
    const navigation = navigate();
    const pathname = router.getState().location.pathname;
    const checkOwner = () => {
      const state = router.getState();
      const target = state.pendingMatches[0] ?? state.matches[0];
      // Same-path replacements remove one-shot focus hints while Chat renders.
      if (target?.routeId !== to || state.location.pathname !== pathname) {
        cancel();
      }
    };
    stop = router.subscribe(checkOwner);
    checkOwner();
    await Promise.race([
      (async () => {
        await navigation;
        await outlet?.updateComplete;
        await chatReady.ready;
      })(),
      cancellation,
    ]);
    if (canceled || prefersReducedMotion) {
      return;
    }
    animation = outlet?.animate?.(SESSION_ROUTE_ENTER_KEYFRAMES, SESSION_ROUTE_ENTER_OPTIONS);
    await Promise.race([animation?.finished.catch(() => undefined), cancellation]);
  } finally {
    stop();
    signal?.removeEventListener("abort", cancel);
    chatReady.cancel();
  }
}

export async function navigateWithRouteTransition(options: RouteTransitionOptions): Promise<void> {
  const { from, navigate, to } = options;
  if (from !== "new-session" || to !== "chat") {
    return navigate();
  }

  // Navigation commits the URL while the outlet keeps the submitted prompt live.
  // Only the entrance animation waits for the rendered chat composer.
  return navigateAndAnimate(options);
}
