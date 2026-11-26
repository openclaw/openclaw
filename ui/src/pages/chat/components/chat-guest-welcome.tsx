import { lazy, Show } from "solid-js";
import type { GuestWelcomeHandle } from "../../../app/guest-welcome-handle.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const GuestWelcomeStatus = lazy(() => import("./chat-guest-welcome-status.tsx"), {
  export: "GuestWelcomeStatus",
});

/** Observe the app-wide owner without loading status UI for ordinary sessions. */
export function renderGuestWelcomeStatus(owner: GuestWelcomeHandle) {
  const state = projectOwner(owner, (current) => current.presentation);
  return (
    <Show when={state.read().kind !== "hidden"}>
      <ChatLazyBoundary>
        <GuestWelcomeStatus presentation={state.read()} onRetry={() => owner.retry()} />
      </ChatLazyBoundary>
    </Show>
  );
}
