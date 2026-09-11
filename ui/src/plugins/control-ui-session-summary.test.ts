import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "../app/gateway-store.test-support.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import "./control-ui-session-summary.ts";

const gateways: ApplicationGateway[] = [];
afterEach(() => {
  document.body.replaceChildren();
  for (const gateway of gateways.splice(0)) {
    gateway.stop();
  }
  vi.restoreAllMocks();
});

function setup() {
  const { gateway, current } = createGatewayStoreTestStore();
  gateways.push(gateway);
  gateway.start();
  current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  const requests: Array<{
    params: unknown;
    resolve: (history: ChatHistoryResult) => void;
  }> = [];
  current().request.mockImplementation((method, params) => {
    if (method === "chat.history") {
      return new Promise<ChatHistoryResult>((resolve) => {
        requests.push({ params, resolve });
      });
    }
    if (method === "progressCard.get") {
      return Promise.resolve({ card: null });
    }
    return Promise.reject(new Error(`Unexpected method: ${method}`));
  });
  const element = document.createElement("openclaw-plugin-session-summary");
  element.gateway = gateway;
  element.session = { sessionKey: "agent:main:one", agentId: "main" };
  element.presented = true;
  document.body.append(element);
  const emit = (event: string, key = "agent:main:one", agentId = "main") =>
    current().opts.onEvent?.(createGatewayEvent(event, { sessionKey: key, agentId }));
  return { element, requests, emit, current };
}

function history(text: string): ChatHistoryResult {
  return { messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

describe("plugin session summary freshness", () => {
  it("refreshes the same session on durable events and coalesces updates during a pending load", async () => {
    const { element, requests, emit } = setup();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]!.resolve(history("Initial reply"));
    await vi.waitFor(() => expect(element.textContent).toContain("Initial reply"));

    emit("session.message", "agent:other:one", "other");
    emit("chat");
    await element.updateComplete;
    expect(requests).toHaveLength(1);

    emit("session.message");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(element.textContent).toContain("Initial reply");
    emit("sessions.changed");
    emit("session.message");
    await element.updateComplete;
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(history("Intermediate reply"));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[2]!.resolve(history("Final reply"));
    await vi.waitFor(() => expect(element.textContent).toContain("Final reply"));
    expect(element.textContent).not.toContain("Initial reply");

    element.presented = false;
    await element.updateComplete;
    emit("session.message");
    await element.updateComplete;
    expect(requests).toHaveLength(3);
    expect(element.textContent).toBe("");
  });

  it("rejects an old session response and reloads after reconnect without a parent render", async () => {
    const { element, requests, emit, current } = setup();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    element.session = { sessionKey: "agent:main:two", agentId: "main" };
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(history("Second session"));
    await vi.waitFor(() => expect(element.textContent).toContain("Second session"));
    requests[0]!.resolve(history("Stale first session"));
    await Promise.resolve();
    await element.updateComplete;
    expect(element.textContent).not.toContain("Stale first session");
    emit("session.message");
    await element.updateComplete;
    expect(requests).toHaveLength(2);

    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    await element.updateComplete;
    current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[2]!.resolve(history("Reconnected session"));
    await vi.waitFor(() => expect(element.textContent).toContain("Reconnected session"));
  });
});
