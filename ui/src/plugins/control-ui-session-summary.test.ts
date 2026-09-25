import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentityResult } from "../api/types.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "../app/gateway-store.test-support.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
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

function setup(identity?: () => AgentIdentityResult) {
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
    if (method === "agent.identity.get" && identity) {
      return Promise.resolve(identity());
    }
    if (method === "progressCard.get") {
      return Promise.resolve({ card: null });
    }
    return Promise.reject(new Error(`Unexpected method: ${method}`));
  });
  const element = document.createElement("openclaw-plugin-session-summary");
  element.gateway = gateway;
  element.agentIdentity = identity ? createAgentIdentityCapability(gateway) : null;
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
  it("refreshes visible message avatars from identity and stops hydrating while hidden", async () => {
    let avatar = "data:image/png;base64,aWRlbnRpdHk=";
    const { element, requests, current } = setup(() => ({ agentId: "main", name: "Main", avatar }));
    element.agents = [
      { id: "main", identity: { avatarUrl: "data:image/png;base64,cm9zdGVy" } },
      { id: "unused" },
    ];
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]!.resolve(history("Agent response"));
    await vi.waitFor(() => {
      expect(element.querySelector("openclaw-agent-avatar img")?.getAttribute("src")).toBe(avatar);
    });
    const identityRequests = () =>
      current().request.mock.calls.filter(([method]) => method === "agent.identity.get");
    expect(identityRequests().map(([, params]) => params)).toEqual([{ agentId: "main" }]);

    avatar = "data:image/png;base64,bmV3";
    element.agentIdentity!.invalidate(["main"]);
    await vi.waitFor(() => {
      expect(element.querySelector("openclaw-agent-avatar img")?.getAttribute("src")).toBe(avatar);
    });

    element.presented = false;
    await element.updateComplete;
    const beforeHiddenInvalidation = identityRequests().length;
    element.agentIdentity!.invalidate(["main"]);
    await Promise.resolve();
    await element.updateComplete;
    expect(element.querySelector("openclaw-agent-avatar")).toBeNull();
    expect(identityRequests()).toHaveLength(beforeHiddenInvalidation);
  });

  it.each(["session", "agent", "connection", "gateway"] as const)(
    "does not commit another owner's transcript when the %s changes",
    async (change) => {
      const { element, requests, current } = setup();
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      requests[0]!.resolve(history("Previous owner transcript"));
      await vi.waitFor(() => expect(element.textContent).toContain("Previous owner transcript"));
      await element.updateComplete;
      let nextRequests = requests;
      if (change === "gateway") {
        const replacement = setup();
        await vi.waitFor(() => expect(replacement.requests).toHaveLength(1));
        nextRequests = replacement.requests;
        element.gateway = replacement.element.gateway;
      } else if (change === "session") {
        element.session = { sessionKey: "agent:main:two", agentId: "main" };
      } else if (change === "agent") {
        element.session = { sessionKey: "agent:main:one", agentId: "other" };
      } else {
        current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
        current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
      }
      const committedText: string[] = [];
      element.addController({
        hostUpdated: () => committedText.push(element.textContent ?? ""),
      });
      await vi.waitFor(() => expect(nextRequests).toHaveLength(2));
      expect(committedText.length).toBeGreaterThan(0);
      expect(committedText.every((text) => !text.includes("Previous owner transcript"))).toBe(true);
      nextRequests[1]!.resolve(history("Current owner transcript"));
      await vi.waitFor(() => expect(element.textContent).toContain("Current owner transcript"));
    },
  );

  it("normalizes visible message text without reviving assistant commentary or tool output", async () => {
    const { element, requests } = setup();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const context = 'Context: ⟦openclaw:ctx⟧\n{"internal": "hidden-envelope"}';
    requests[0]!.resolve({
      messages: [
        { role: "user", content: `Visible request\n\n${context}` },
        { role: "assistant", phase: "commentary", content: "Hidden commentary" },
        { role: "toolResult", content: "Hidden tool output" },
        {
          role: "assistant",
          senderLabel: "Reviewer",
          content: [
            { type: "text", text: "Hidden legacy text" },
            {
              type: "text",
              text: "Hidden phased commentary",
              textSignature: '{"v":1,"phase":"commentary"}',
            },
            {
              type: "text",
              text: `Visible **answer**\nMEDIA:https://example.com/proof.png\n\n${context}`,
              textSignature: '{"v":1,"phase":"final_answer"}',
            },
          ],
        },
        { role: "assistant", content: context },
      ],
    });
    await vi.waitFor(() => expect(element.textContent).toContain("Visible answer"));
    expect(element.textContent).toContain("Visible request");
    expect(element.textContent).toContain("Reviewer");
    expect(element.querySelectorAll(".plugin-session-summary__message")).toHaveLength(2);
    expect(element.querySelector(".sidebar-markdown strong")?.textContent).toBe("answer");
    expect(element.textContent).not.toMatch(
      /Hidden|hidden-envelope|openclaw:ctx|MEDIA:|proof\.png/,
    );
  });

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
    element.presented = true;
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    requests[3]!.resolve(history("Reply received while hidden"));
    await vi.waitFor(() => expect(element.textContent).toContain("Reply received while hidden"));
  });

  it("does not resume progress requests after removal with an update queued", async () => {
    const { element, requests, current } = setup();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]!.resolve(history("Initial reply"));
    await vi.waitFor(() => expect(element.textContent).toContain("Initial reply"));
    await element.updateComplete;
    const progressRequests = () =>
      current().request.mock.calls.filter(([method]) => method === "progressCard.get");
    expect(progressRequests()).toHaveLength(1);

    element.requestUpdate();
    element.remove();
    await element.updateComplete;
    current().opts.onEvent?.(
      createGatewayEvent("progressCard.changed", { sessionKey: "agent:main:one", revision: 2 }),
    );
    await element.updateComplete;
    expect(progressRequests()).toHaveLength(1);
    expect(requests).toHaveLength(1);

    document.body.append(element);
    element.requestUpdate();
    await element.updateComplete;
    await vi.waitFor(() => expect(progressRequests()).toHaveLength(2));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(history("Reconnected reply"));
    await vi.waitFor(() => expect(element.textContent).toContain("Reconnected reply"));
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
