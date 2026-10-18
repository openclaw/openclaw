import { getObserver } from "@solidjs/signals";
import { projectSource } from "../../lib/reactive/projection.ts";
import type { ChatErrorState } from "./chat-error-state.ts";

/** Keep error ownership synchronous while tracking its two presentation fields. */
export function projectChatErrors<T extends ChatErrorState>(state: T): T {
  const errors = projectSource(state, {
    read: (owner) => owner.readErrors(),
    subscribe: (owner, notify) => owner.subscribeErrors(notify),
    equality: (previous, next) =>
      previous.lastError === next.lastError && previous.chatError === next.chatError,
  });
  for (const key of ["lastError", "chatError"] as const) {
    Object.defineProperty(state, key, {
      ...Object.getOwnPropertyDescriptor(state, key),
      get: () => (getObserver() ? errors.read()[key] : state.readErrors()[key]),
    });
  }
  return state;
}
