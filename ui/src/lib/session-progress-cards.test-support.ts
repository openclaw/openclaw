import { vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";

export const sessionKey = "agent:main:progress-date-boundary";

export function createProgressCard(updatedAt: number) {
  return { sessionKey, revision: 1, updatedAt, markdown: "Progress update" };
}

export function createGateway(mainSessionKey?: string, mainKey = "main") {
  const request = vi.fn();
  const features = {
    methods: ["progressCard.get", "progressCard.put"],
  };
  let onEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] | undefined;
  let onSnapshot: Parameters<ApplicationGateway["subscribe"]>[0] | undefined;
  const gateway = {
    snapshot: {
      client: { request },
      phase: "connected",
      hello: {
        features,
        snapshot: { sessionDefaults: { mainSessionKey, mainKey, defaultAgentId: "main" } },
      },
    },
    subscribe: (listener: NonNullable<typeof onSnapshot>) => {
      onSnapshot = listener;
      return () => {
        onSnapshot = undefined;
      };
    },
    subscribeEvents: (listener: NonNullable<typeof onEvent>) => {
      onEvent = listener;
      return () => {
        onEvent = undefined;
      };
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    request,
    features,
    snapshotChanged: () => onSnapshot?.(gateway.snapshot),
    emit: (event: Parameters<NonNullable<typeof onEvent>>[0]) => onEvent?.(event),
    emitChange: (changedSessionKey: string, revision: number | null) =>
      onEvent?.({
        type: "event",
        event: "progressCard.changed",
        payload: { sessionKey: changedSessionKey, revision },
      }),
  };
}
