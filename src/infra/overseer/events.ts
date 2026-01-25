import type { OverseerEvent, OverseerStore } from "./store.types.js";

export function appendOverseerEvent(store: OverseerStore, event: OverseerEvent) {
  if (!store.events) store.events = [];
  store.events.push(event);
}

export function appendOverseerEvents(store: OverseerStore, events: OverseerEvent[]) {
  if (!store.events) store.events = [];
  store.events.push(...events);
}
