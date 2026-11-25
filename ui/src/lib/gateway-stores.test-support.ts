import { vi, type Mock } from "vitest";
import { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";

export function watchedGateway(snapshot: Partial<ApplicationGatewaySnapshot>) {
  const harness = createApplicationGateway({
    ...createApplicationGateway().gateway.snapshot,
    phase: "connected",
    assistantAgentId: "main",
    ...snapshot,
  });
  const subscribe = harness.gateway.subscribe.bind(harness.gateway);
  const unsubscribe = vi.fn((detach: () => void) => detach());
  vi.spyOn(harness.gateway, "subscribe").mockImplementation((listener) => {
    const detach = subscribe(listener);
    return () => unsubscribe(detach);
  });
  return { ...harness, unsubscribe };
}

export function pendingSetRequests(request: Mock<GatewayBrowserClient["request"]>, prefix: string) {
  const ids: string[] = [];
  const retired: string[] = [];
  const pending = new GatewayPendingRequests({
    createRequestId: () => prefix,
    nowMs: () => Date.now(),
    onTiming: ({ errorCode }) => {
      if (errorCode) {
        retired.push(errorCode);
      }
    },
  });
  request.mockImplementation((method, params, options) =>
    pending.request({ send: () => undefined }, method, params, {
      ...options,
      onSent: (id) => ids.push(id),
    }),
  );
  return {
    pending,
    retired,
    acknowledge: (index: number) => {
      pending.handleResponse({ type: "res", id: ids[index]!, ok: true, payload: {} });
    },
  };
}
