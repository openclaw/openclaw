import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentIdentityResult } from "../api/types.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "../app/gateway-store.test-support.ts";
import { t } from "../i18n/index.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import type { ChatHistoryResponse } from "../pages/chat/chat-history-snapshot.ts";
import "./control-ui-session-summary.tsx";

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(
  identity?: () => AgentIdentityResult,
  progressRead: () => Promise<unknown> = async () => ({ card: null }),
) {
  const { gateway, current } = createGatewayStoreTestStore();
  onTestFinished(() => gateway.stop());
  gateway.start();
  current().testOptions.onHello?.({
    ...GATEWAY_STORE_TEST_HELLO,
    auth: { role: "operator", scopes: ["operator.sessions.read"] },
  });
  const requests: Array<{
    params: unknown;
    resolve: (history: ChatHistoryResponse) => void;
    reject: (error: unknown) => void;
  }> = [];
  current().request.mockImplementation((method, params) => {
    if (method === "chat.history") {
      return new Promise<ChatHistoryResponse>((resolve, reject) => {
        requests.push({ params, resolve, reject });
      });
    }
    if (method === "agent.identity.get" && identity) {
      return Promise.resolve(identity());
    }
    if (method === "progressCard.get") {
      return progressRead();
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
    current().testOptions.onEvent?.(createGatewayEvent(event, { sessionKey: key, agentId }));
  const shown = (text: string) => vi.waitFor(() => expect(element.textContent).toContain(text));
  const reply = async (index: number, text: string, data: ChatHistoryResponse = history(text)) => {
    await vi.waitFor(() => expect(requests).toHaveLength(index + 1));
    requests[index]!.resolve(data);
    await shown(text);
  };
  const calls = (method: string) =>
    current().request.mock.calls.filter(([name]) => name === method);
  const settled = async (count: number) => {
    await element.updateComplete;
    expect(requests).toHaveLength(count);
  };
  return { element, requests, emit, current, shown, reply, calls, settled };
}

const textBlock = (text: string, phase?: string) => ({
  type: "text",
  text,
  ...(phase ? { textSignature: JSON.stringify({ v: 1, phase }) } : {}),
});
const history = (text: string) => ({
  messages: [{ role: "assistant", content: [textBlock(text)] }],
});
function useClock() {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
}
const messages = (element: Element) => element.querySelectorAll(".plugin-session-summary__message");

it("keeps history available while progress loads, fails, and retries", async () => {
  const pending = createDeferred<{ card: null }>();
  const retry = createDeferred<{ card: null }>();
  const read = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
  const { element, reply } = setup(undefined, read);
  await reply(0, "Independent history");
  expect(element.textContent).toContain(t("sessionProgressCard.widgetLoading"));
  pending.reject(new Error("Progress unavailable"));
  await vi.waitFor(() =>
    expect(element.querySelector(".plugin-session-summary__progress [role=alert]")).not.toBeNull(),
  );
  expect(element.textContent).toContain("Independent history");

  element.querySelector<HTMLButtonElement>(".plugin-session-summary > button")!.click();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(element.textContent).toContain(t("sessionProgressCard.widgetLoading")),
  );
  expect(element.textContent).toContain("Independent history");
  retry.resolve({ card: null });
  await vi.waitFor(() =>
    expect(element.querySelector(".plugin-session-summary__progress")).toBeNull(),
  );
  expect(element.textContent).toContain("Independent history");
});

it("refreshes visible message avatars from identity and stops hydrating while hidden", async () => {
  let avatar = "data:image/png;base64,aWRlbnRpdHk=";
  const { element, reply, calls } = setup(() => ({ agentId: "main", name: "Main", avatar }));
  element.agents = [
    { id: "main", identity: { avatarUrl: "data:image/png;base64,cm9zdGVy" } },
    { id: "unused" },
  ];
  const avatarLoaded = () =>
    vi.waitFor(() =>
      expect(element.querySelector("openclaw-agent-avatar img")?.getAttribute("src")).toBe(avatar),
    );
  await reply(0, "Agent response");
  await avatarLoaded();
  const identityRequests = () => calls("agent.identity.get");
  expect(identityRequests().map(([, params]) => params)).toEqual([{ agentId: "main" }]);

  avatar = "data:image/png;base64,bmV3";
  element.agentIdentity!.invalidate(["main"]);
  await avatarLoaded();

  const replacement = createAgentIdentityCapability(element.gateway!);
  element.agentIdentity = replacement;
  await vi.waitFor(() => expect(replacement.get("main")?.avatar).toBe(avatar));
  await avatarLoaded();

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
    const { element, requests, current, reply, shown } = setup();
    await reply(0, "Previous owner transcript");
    await element.updateComplete;
    const committedText: string[] = [];
    const observer = new MutationObserver(() => committedText.push(element.textContent ?? ""));
    observer.observe(element, { childList: true, characterData: true, subtree: true });
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
      current().testOptions.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
      current().testOptions.onHello?.(GATEWAY_STORE_TEST_HELLO);
    }
    await vi.waitFor(() => expect(nextRequests).toHaveLength(2));
    expect(committedText.length).toBeGreaterThan(0);
    expect(committedText.every((text) => !text.includes("Previous owner transcript"))).toBe(true);
    observer.disconnect();
    nextRequests[1]!.resolve(history("Current owner transcript"));
    await shown("Current owner transcript");
  },
);

it("normalizes visible message text without reviving assistant commentary or tool output", async () => {
  const { element, reply } = setup();
  const context = 'Context: ⟦openclaw:ctx⟧\n{"internal": "hidden-envelope"}';
  await reply(0, "Visible answer", {
    messages: [
      { role: "user", content: `Visible request\n\n${context}` },
      { role: "assistant", phase: "commentary", content: "Hidden commentary" },
      { role: "toolResult", content: "Hidden tool output" },
      {
        role: "assistant",
        senderLabel: "Reviewer",
        content: [
          textBlock("Hidden legacy text"),
          textBlock("Hidden phased commentary", "commentary"),
          textBlock(
            `Visible **answer**\nMEDIA:https://example.com/proof.png\n\n${context}`,
            "final_answer",
          ),
        ],
      },
      { role: "assistant", content: context },
    ],
  });
  expect(element.textContent).toContain("Visible request");
  expect(element.textContent).toContain("Reviewer");
  expect(messages(element)).toHaveLength(2);
  expect(element.querySelector(".sidebar-markdown strong")?.textContent).toBe("answer");
  expect(element.textContent).not.toMatch(/Hidden|hidden-envelope|openclaw:ctx|MEDIA:|proof\.png/);
});

it("retains its successful history and cursor when retrying a failed refresh", async () => {
  useClock();
  const { element, requests, emit, reply } = setup();
  await reply(0, "Retained reply", {
    ...history("Retained reply"),
    deltaCursor: "last-successful",
  });

  emit("session.message");
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  requests[1]!.reject(new Error("History read unavailable"));
  const error = () => element.querySelector(".plugin-session-summary__history [role=alert]");
  await vi.waitFor(() => expect(error()).not.toBeNull());
  expect(element.textContent).not.toContain("Retained reply");

  const retry = element.querySelector<HTMLButtonElement>(".plugin-session-summary > button");
  expect(retry).not.toBeNull();
  retry!.click();
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]!.params).toMatchObject({ cursor: "last-successful" });
  await vi.waitFor(() => {
    expect(element.textContent).toContain("Retained reply");
    expect(error()).toBeNull();
  });
  await reply(2, "Recovered reply");
  expect(element.textContent).not.toContain("Retained reply");
});

it("paces durable events and retains one catch-up during a pending load", async () => {
  useClock();
  const { element, requests, emit, reply, settled } = setup();
  await reply(0, "Initial reply");

  emit("session.message", "agent:other:one", "other");
  emit("chat");
  await settled(1);

  emit("session.message");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(element.textContent).toContain("Initial reply");
  emit("sessions.changed");
  emit("session.message");
  await settled(2);
  requests[1]!.resolve(history("Intermediate reply"));
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(5_000);
  await reply(2, "Final reply");
  expect(element.textContent).not.toContain("Initial reply");

  element.presented = false;
  await element.updateComplete;
  emit("session.message");
  await vi.advanceTimersByTimeAsync(10_000);
  await element.updateComplete;
  expect(requests).toHaveLength(3);
  expect(element.textContent).toBe("");
  element.presented = true;
  await reply(3, "Reply received while hidden");
});

it("catches up with cursors, retains a bounded tail, and replaces it after a reset", async () => {
  useClock();
  const { element, requests, emit, reply, shown } = setup();
  const message = (seq: number) => ({
    role: "assistant",
    content: [textBlock(`Reply ${seq}.`)],
    __openclaw: { id: `reply-${seq}`, seq },
  });
  const sessionInfo = { key: "agent:main:one", sessionId: "one", kind: "direct" as const };
  await reply(0, "Reply 20.", {
    messages: Array.from({ length: 20 }, (_, index) => message(index + 1)),
    deltaCursor: "cursor-20",
    sessionInfo,
  });

  emit("session.message");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(requests[1]!.params).toMatchObject({ cursor: "cursor-20", maxChars: 12000 });
  await reply(1, "Reply 21.", {
    kind: "delta",
    deltaCursor: "cursor-21",
    sessionInfo,
    messages: [20, 21].map((seq) => ({
      sessionKey: sessionInfo.key,
      messageId: `reply-${seq}`,
      messageSeq: seq,
      message: message(seq),
    })),
  });
  expect(element.textContent).toContain("Reply 2.");
  expect(element.textContent).not.toContain("Reply 1.");
  expect(messages(element)).toHaveLength(20);

  emit("sessions.changed");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(requests[2]!.params).toMatchObject({ cursor: "cursor-21" });
  requests[2]!.resolve({ kind: "delta", deltaCursor: "unchanged", sessionInfo, messages: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(messages(element)).toHaveLength(20);

  emit("sessions.changed");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(requests[3]!.params).toMatchObject({ cursor: "unchanged" });
  requests[3]!.resolve({ kind: "reset" });
  await vi.waitFor(() => expect(requests).toHaveLength(5));
  expect(requests[4]!.params).not.toHaveProperty("cursor", "unchanged");
  requests[4]!.resolve({ ...history("Replacement branch"), deltaCursor: "replacement" });
  await shown("Replacement branch");
  expect(element.textContent).not.toContain("Reply 21.");
});

it("does not resume progress requests after removal with an update queued", async () => {
  const { element, current, reply, calls, settled } = setup();
  await reply(0, "Initial reply");
  await settled(1);
  const progressRequests = () => calls("progressCard.get");
  expect(progressRequests()).toHaveLength(1);

  element.session = { ...element.session! };
  element.remove();
  await element.updateComplete;
  current().testOptions.onEvent?.(
    createGatewayEvent("progressCard.changed", { sessionKey: "agent:main:one", revision: 2 }),
  );
  await settled(1);
  expect(progressRequests()).toHaveLength(1);

  document.body.append(element);
  element.session = { ...element.session! };
  await element.updateComplete;
  await vi.waitFor(() => expect(progressRequests()).toHaveLength(2));
  await reply(1, "Reconnected reply");
});

it("rejects an old session response and reloads after reconnect without a parent render", async () => {
  const { element, requests, emit, current, reply, settled } = setup();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  element.session = { sessionKey: "agent:main:two", agentId: "main" };
  await reply(1, "Second session");
  requests[0]!.resolve(history("Stale first session"));
  await Promise.resolve();
  await element.updateComplete;
  expect(element.textContent).not.toContain("Stale first session");
  emit("session.message");
  await settled(2);

  current().testOptions.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
  await element.updateComplete;
  current().testOptions.onHello?.(GATEWAY_STORE_TEST_HELLO);
  await reply(2, "Reconnected session");
});
