import { nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createSidebarFullMessageLoader } from "./chat-pane-sidebar-layout.ts";
import { applyChatPendingInputs, loadChatPendingInputs } from "./chat-pending-inputs.ts";
import { createChatSavedInputs } from "./chat-saved-inputs.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import {
  getTranscriptState,
  resetThreadPresentation,
} from "./components/chat-thread-interactions.ts";

const input = {
  id: "saved",
  state: "interrupted",
  acceptedAt: 10,
  message: {
    role: "user",
    content: "Loaded preview",
    __openclaw: { id: "pending:saved", truncated: true },
  },
} as const;
const full = {
  ok: true,
  message: {
    role: "user",
    content: "Complete private payload",
    __openclaw: { id: "pending:saved" },
  },
};
function fixture() {
  const deferred = createDeferred<typeof full>();
  const host = makeChatHost({
    sessionKey: "agent:main:saved",
    currentSessionId: "saved-session",
    requestHandlers: { "chat.message.get": () => deferred.promise },
  });
  const abort = new AbortController();
  const props = createChatProps({
    historyState: host,
    sessionKey: host.sessionKey,
    paneId: "saved-test",
    readSignal: abort.signal,
    loadFullAssistantMessage: createSidebarFullMessageLoader(host, false),
  });
  applyChatPendingInputs(host, { items: [input], total: 1 });
  return { host, props, deferred, abort };
}
afterEach(() => resetThreadPresentation("saved-test"));

describe("pane-local saved input inspection", () => {
  it("keeps the same saved source open across fresh display projections", async () => {
    const { host, props, deferred } = fixture();
    const saved = createChatSavedInputs(props)!;
    const loading = saved.onToggle(input, true);
    const refresh = () =>
      applyChatPendingInputs(host, { items: [structuredClone(input)], total: 1 });
    refresh();
    deferred.resolve(full);
    await loading;
    expect(createChatSavedInputs(props)?.inspections.get(input.id)?.state?.status).toBe("loaded");
    refresh();
    expect(createChatSavedInputs(props)?.inspections.get(input.id)?.state?.status).toBe("loaded");
    expect(host.request).toHaveBeenCalledOnce();
  });
  it("keeps an authenticated viewer's saved read across cosmetic profile changes", async () => {
    const { host, props, deferred } = fixture();
    host.selfUser = { id: "viewer", name: "Before", avatarUrl: "/before.png" };
    applyChatPendingInputs(host, { items: [input], total: 1 });
    const saved = createChatSavedInputs(props)!;
    const loading = saved.onToggle(input, true);
    host.selfUser = { ...host.selfUser, name: "After", avatarUrl: "/after.png" };
    deferred.resolve(full);
    await loading;
    const refreshed = createChatSavedInputs(props);
    expect(refreshed?.items).toHaveLength(1);
    expect(refreshed?.inspections.get(input.id)?.state?.status).toBe("loaded");
    expect(host.request).toHaveBeenCalledOnce();
  });
  it.each(["input ID", "run ID"] as const)(
    "lets active custody supersede a stale saved copy by %s",
    async (correlation) => {
      const { host, props, deferred } = fixture();
      const savedInput = { ...input, runId: "current-run" };
      applyChatPendingInputs(host, { items: [savedInput], total: 1, queue: { items: [] } });
      const saved = createChatSavedInputs(props)!;
      const read = saved.onToggle(savedInput, true);
      const active = {
        ...savedInput,
        id: correlation === "input ID" ? savedInput.id : "current-input",
        state: "queued" as const,
        queued: true as const,
        message: { role: "user", content: "Current queued input" },
      };
      applyChatPendingInputs(host, { items: [savedInput], total: 1, queue: { items: [active] } });
      expect(createChatSavedInputs(props)).toBeUndefined();
      deferred.resolve(full);
      await read;
      expect(saved.inspections.get(input.id)?.state?.status).not.toBe("loaded");
      const container = document.createElement("div");
      render(renderChat(props), container);
      expect(container.querySelectorAll("[data-chat-saved-input]")).toHaveLength(0);
      expect(container.querySelectorAll("[data-chat-queue-item]")).toHaveLength(1);
      expect(container.textContent).toContain("Current queued input");
      render(nothing, container);
    },
  );

  it.each([
    [
      "wrong source",
      { ...full, message: { ...full.message, __openclaw: { id: "pending:other" } } },
    ],
    ["still capped", { ok: true, message: input.message }],
    ["unavailable", { ok: false }],
  ])("does not display an unusable full read (%s)", async (_name, result) => {
    const { host, props } = fixture();
    host.request.mockResolvedValue(result);
    const saved = createChatSavedInputs(props)!;
    await saved.onToggle(input, true);
    expect(saved.inspections.get(input.id)?.state?.status).toBe("error");
    expect(host.request).toHaveBeenCalledOnce();
  });
  it.each([
    "close",
    "source",
    "custody state",
    "remove",
    "epoch",
    "session",
    "client",
    "agent",
    "viewer",
    "read scope",
  ] as const)("rejects a full-message completion after %s invalidation", async (change) => {
    const { host, props, deferred, abort } = fixture();
    if (change === "agent") {
      host.sessionKey = "global";
      host.assistantAgentId = "main";
      props.sessionKey = host.sessionKey;
      applyChatPendingInputs(host, { items: [input], total: 1 });
    }
    const saved = createChatSavedInputs(props)!;
    const pending = saved.onToggle(input, true);
    expect(saved.inspections.get(input.id)?.state?.status).toBe("loading");
    switch (change) {
      case "close":
        await saved.onToggle(input, false);
        break;
      case "source":
        applyChatPendingInputs(host, {
          items: [
            {
              ...input,
              id: "replacement",
              message: {
                ...input.message,
                content: "Changed source",
                __openclaw: { id: "pending:replacement", truncated: true },
              },
            },
          ],
          total: 1,
        });
        break;
      case "custody state":
        applyChatPendingInputs(host, { items: [{ ...input, state: "cancelled" }], total: 1 });
        break;
      case "remove":
        applyChatPendingInputs(host, { items: [], total: 0 });
        break;
      case "epoch":
        host.connectionEpoch++;
        break;
      case "session":
        host.currentSessionId = "different";
        break;
      case "client":
        host.client = createTestGatewayClient(host.request);
        break;
      case "agent":
        host.assistantAgentId = "other";
        break;
      case "viewer":
        host.selfUser = { id: "other-viewer" };
        break;
      case "read scope":
        abort.abort();
        break;
    }
    deferred.resolve(full);
    await pending;
    const next = createChatSavedInputs(props);
    expect(next?.inspections.get(input.id)?.state?.status).not.toBe("loaded");
    expect(host.request.mock.calls.filter(([method]) => method !== "chat.message.get")).toEqual([]);
  });
  it("retries only explicitly, keeps the existing offline view, and searches previews rather than the inspection cache", async () => {
    const { host, props, deferred } = fixture();
    let saved = createChatSavedInputs(props)!;
    const pending = saved.onToggle(input, true);
    deferred.reject(new Error("Unavailable"));
    await pending;
    expect(saved.inspections.get(input.id)?.state?.status).toBe("error");
    host.request.mockResolvedValue(full);
    await saved.onToggle(input, true);
    saved = createChatSavedInputs(props)!;
    expect(saved.inspections.get(input.id)?.state?.status).toBe("loaded");
    host.connected = false;
    expect(createChatSavedInputs(props)?.inspections.get(input.id)?.state?.status).toBe("loaded");
    const search = getTranscriptState(props.paneId);
    search.searchOpen = true;
    search.searchQuery = "private payload";
    expect(createChatSavedInputs(props)).toBeUndefined();
    search.searchQuery = "Loaded preview";
    expect(createChatSavedInputs(props)?.items.map((row) => row.id)).toEqual(["saved"]);
    host.selfUser = { id: "new-offline-viewer" };
    expect(createChatSavedInputs(props)).toBeUndefined();
    expect(host.request.mock.calls.map(([method]) => method)).toEqual([
      "chat.message.get",
      "chat.message.get",
    ]);
  });
  it("does not certify an old page when a reconnect navigation merely starts", async () => {
    const { host, props } = fixture();
    expect(createChatSavedInputs(props)?.items).toHaveLength(1);
    const response = createDeferred<unknown>();
    host.request.mockImplementation(() => response.promise);
    host.connectionEpoch++;
    const loading = loadChatPendingInputs(host, 1);
    expect(createChatSavedInputs(props)).toBeUndefined();
    response.resolve({
      sessionId: host.currentSessionId,
      pendingInputs: { items: [input], total: 1 },
    });
    await loading;
    expect(createChatSavedInputs(props)?.items).toHaveLength(1);
  });
  it.each(["read-only", "suggestion", "provider-review"] as const)(
    "lets %s viewers inspect without mounting content actions",
    async (mode) => {
      const { host, props } = fixture();
      props.canSend = mode !== "read-only";
      props.suggestionComposer = mode === "suggestion";
      props.submitDisabledReason = mode === "provider-review" ? "Review provider" : undefined;
      const card = {
        type: "clawhub",
        kind: "plugin",
        id: "ch_fixture",
        name: "Forwarded recommendation",
        description: "Saved content only",
        official: true,
        installed: false,
      };
      const forwarded = {
        ...input,
        message: {
          role: "assistant",
          senderSession: { sessionKey: "agent:other:main", label: "Other agent" },
          content: [{ type: "text", text: "Forwarded assistant content" }, card],
        },
      };
      applyChatPendingInputs(host, { items: [forwarded], total: 1 });
      const saved = createChatSavedInputs(props)!;
      await saved.onToggle(forwarded, true);
      const container = document.createElement("div");
      render(renderChat(props), container);
      expect(container.textContent).toContain("Forwarded recommendation");
      expect(
        container
          .querySelector("[data-chat-saved-input]")!
          .querySelectorAll(
            "openclaw-chat-clawhub-card, iframe, a, button:not(.chat-copy-btn), .chat-tool-card",
          ),
      ).toHaveLength(0);
      expect(host.request.mock.calls).toEqual([]);
      render(nothing, container);
    },
  );
});
