import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import { MCP_APP_RESOURCE_MENTION_EVENT } from "../../components/mcp-app-resource-mention.ts";
import {
  MCP_APP_CONTEXT_EVENT,
  MCP_APP_FILE_OPEN_EVENT,
  MCP_APP_MESSAGE_EVENT,
  WIDGET_PROMPT_EVENT,
  type McpAppMessageEventDetail,
} from "../../components/mcp-app-security.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { readMcpAppContexts } from "../../lib/mcp-app-context.ts";
import * as appMessages from "../../lib/mcp-app-new-conversation.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { StartedSessionNavigation } from "../new-session/started-session-navigation.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createChatPaneMcpApps, type ChatPaneMcpAppOwner } from "./chat-pane-mcp-app.ts";
import { handleAbortChat } from "./run-lifecycle.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const element = document.createElement("div");
  document.body.append(element);
  const client = createTestGatewayClient(async () => ({}));
  const gateway = createApplicationGateway();
  gateway.publish({
    ...gateway.gateway.snapshot,
    phase: "connected",
    client,
    sessionKey: "agent:main:one",
  });
  // These events only read gateway state; new-session delivery is observed at its existing owner.
  const agentSelection = { intentRevision: 0 };
  const context = { gateway: gateway.gateway, agentSelection } as ApplicationContext;
  const state: ChatPaneMcpAppOwner["state"] = {
    client,
    connected: true,
    sessionKey: "agent:main:one",
    assistantAgentId: "main",
    chatAttachments: [],
    hello: null,
    handleSendChat: vi.fn(async () => {}),
    handleOpenSidebar: vi.fn(),
  };
  const owner: ChatPaneMcpAppOwner = {
    context,
    state,
    presented: true,
    agentId: "fallback",
    replaceAttachments: (attachments) => {
      state.chatAttachments = attachments;
    },
    openFile: vi.fn(),
  };
  let current: ChatPaneMcpAppOwner | null = owner;
  let syncLaunch!: () => void;
  function mount() {
    const dispose = createRoot((stop) => {
      syncLaunch = createChatPaneMcpApps({ element, current: () => current && { ...current } });
      return stop;
    });
    cleanups.push(dispose);
    return dispose;
  }
  const cleanup = mount();
  cleanups.push(() => releaseChatAttachmentPayloads(state.chatAttachments));
  const launch: McpAppOpenDetail = {
    sessionKey: state.sessionKey,
    owner: client,
    serverName: "parts",
    entrypoint: {
      title: "Parts tray",
      toolName: "tray",
      resourceUri: "ui://parts/tray",
      entrypoint: { type: "thread" },
    },
  };
  const dispatch = <T>(name: string, detail: T) => {
    const event = new CustomEvent(name, {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event;
  };
  return {
    element,
    client,
    context,
    agentSelection,
    state,
    owner,
    syncLaunch: () => syncLaunch(),
    mount,
    cleanup,
    launch,
    dispatch,
    setCurrent: (next: ChatPaneMcpAppOwner | null) => {
      current = next;
    },
  };
}

function message(sessionKey: string, target: "active" | "new" = "active") {
  const receipt = createDeferred<boolean>();
  const respond = vi.fn((accepted: boolean) => receipt.resolve(accepted));
  const detail: McpAppMessageEventDetail = {
    sessionKey,
    viewId: "view-one",
    target,
    content: [
      { type: "text", text: "Compare parts" },
      { type: "text", text: "Dimensions", _meta: { "openai/title": "Part measurements" } },
    ],
    respond,
  };
  return { detail, receipt, respond };
}

describe("MCP app pane actions", () => {
  it("claims only the presented matching owner and retains per-launch synchronization", () => {
    const f = fixture();
    f.owner.presented = false;
    expect(f.dispatch(MCP_APP_OPEN_EVENT, f.launch).defaultPrevented).toBe(false);
    f.owner.presented = true;
    expect(
      f.dispatch(MCP_APP_OPEN_EVENT, { ...f.launch, sessionKey: "other" }).defaultPrevented,
    ).toBe(false);
    expect(
      f.dispatch(MCP_APP_OPEN_EVENT, {
        ...f.launch,
        owner: createTestGatewayClient(async () => ({})),
      }).defaultPrevented,
    ).toBe(false);
    expect(f.state.handleOpenSidebar).not.toHaveBeenCalled();
    expect(f.dispatch(MCP_APP_OPEN_EVENT, f.launch).defaultPrevented).toBe(true);
    expect(f.state.handleOpenSidebar).toHaveBeenLastCalledWith(
      expect.objectContaining({
        launch: f.launch,
        fileTab: { id: "mcp-app:parts/tray:app:", label: "Parts tray" },
      }),
    );
    f.owner.launch = f.launch;
    f.syncLaunch();
    f.syncLaunch();
    expect(f.state.handleOpenSidebar).toHaveBeenCalledTimes(2);
    expect(f.state.handleOpenSidebar).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileTab: { id: "mcp-app:parts/tray:app", label: "Parts tray" } }),
    );
    f.owner.launch = { ...f.launch, deepLink: "/second" };
    f.syncLaunch();
    expect(f.state.handleOpenSidebar).toHaveBeenCalledTimes(3);
  });

  it("acknowledges active message custody only after the captured outbox accepts it", async () => {
    const f = fixture();
    const pending = createDeferred();
    const sent = message(f.state.sessionKey);
    let attachments: readonly ChatAttachment[] = [];
    f.state.handleSendChat = vi.fn((_text, options) => {
      attachments = options?.attachmentsOverride ?? [];
      options?.onOutboxAdmitted?.();
      return pending.promise;
    });
    expect(f.dispatch(MCP_APP_MESSAGE_EVENT, sent.detail).defaultPrevented).toBe(true);
    expect(sent.respond).not.toHaveBeenCalled();
    expect(f.state.handleSendChat).toHaveBeenCalledWith(
      "Compare parts",
      expect.objectContaining({
        attachmentsOverride: expect.arrayContaining([
          expect.objectContaining({ fileName: "Part measurements" }),
        ]),
      }),
    );
    f.setCurrent(null);
    f.cleanup();
    pending.resolve();
    expect(await sent.receipt.promise).toBe(true);
    expect(getChatAttachmentDataUrl(attachments[0]!)).not.toBeNull();
    releaseChatAttachmentPayloads(attachments);
  });

  it("releases attachment payloads and reports rejection when no outbox takes custody", async () => {
    const f = fixture();
    const sent = message(f.state.sessionKey);
    let attachments: readonly ChatAttachment[] = [];
    f.state.handleSendChat = vi.fn(async (_text, options) => {
      attachments = options?.attachmentsOverride ?? [];
      throw new Error("rejected");
    });
    f.dispatch(MCP_APP_MESSAGE_EVENT, sent.detail);
    expect(await sent.receipt.promise).toBe(false);
    expect(getChatAttachmentDataUrl(attachments[0]!)).toBeNull();
    expect(sent.respond).toHaveBeenCalledOnce();
  });

  it("delegates new-conversation delivery and acknowledges its existing owner result", async () => {
    const f = fixture();
    const pending = createDeferred<boolean>();
    const sent = message(f.state.sessionKey, "new");
    const create = vi
      .spyOn(appMessages, "sendMcpAppNewConversation")
      .mockReturnValue(pending.promise);
    f.dispatch(MCP_APP_MESSAGE_EVENT, sent.detail);
    await vi.dynamicImportSettled();
    expect(create).toHaveBeenCalledWith(f.context, "main", sent.detail, expect.any(AbortSignal));
    expect(f.state.handleSendChat).not.toHaveBeenCalled();
    expect(sent.respond).not.toHaveBeenCalled();
    pending.resolve(false);
    expect(await sent.receipt.promise).toBe(false);
  });

  it("cancels a new-conversation admission wait when the source pane receives Stop", async () => {
    const f = fixture();
    const host = Object.assign(makeChatHost({ client: f.client, sessionKey: f.state.sessionKey }), {
      handleSendChat: f.state.handleSendChat,
      handleOpenSidebar: f.state.handleOpenSidebar,
    });
    f.owner.state = host;
    const sent = message(host.sessionKey, "new");
    let signal: AbortSignal | undefined;
    vi.spyOn(appMessages, "sendMcpAppNewConversation").mockImplementation(
      (_context, _agentId, _detail, requestSignal) => {
        signal = requestSignal;
        return new Promise<boolean>((resolve) => {
          signal?.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
    );
    f.dispatch(MCP_APP_MESSAGE_EVENT, sent.detail);
    await vi.dynamicImportSettled();
    expect(signal?.aborted).toBe(false);
    await handleAbortChat(host, { preserveDraft: true });
    expect(signal?.aborted).toBe(true);
    expect(await sent.receipt.promise).toBe(false);
  });

  it("acknowledges a dispatched new conversation after Stop without navigating or resending", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = new GatewayPendingRequests({
      createRequestId: () => "mcp-create",
      nowMs: Date.now,
    });
    cleanups.push(() => {
      pending.flush(new Error("test disposed"));
      vi.useRealTimers();
    });
    const frames: RequestFrame[] = [];
    const dispatched = createDeferred<RequestFrame>();
    let requestSignal: AbortSignal | undefined;
    const requestClient = createTestGatewayClient((method, params, options) => {
      if (method !== "sessions.create") {
        return sessionsResult([]);
      }
      requestSignal = options?.signal;
      return pending.request(
        {
          send(raw) {
            // The real request owner serializes this transport frame.
            const frame = JSON.parse(raw) as RequestFrame;
            frames.push(frame);
            dispatched.resolve(frame);
          },
        },
        method,
        params,
        options,
      );
    });
    f.client.request = requestClient.request.bind(requestClient);
    Object.assign(f.context, {
      router: { getState: () => ({ location: "/chat/one" }) },
      sessions: createTestSessionCapability(f.context.gateway),
      chatSubmissions: createChatSubmissions(),
      config: {},
    });
    const navigate = vi.spyOn(StartedSessionNavigation.prototype, "navigate").mockResolvedValue();
    const host = Object.assign(makeChatHost({ client: f.client, sessionKey: f.state.sessionKey }), {
      handleSendChat: f.state.handleSendChat,
      handleOpenSidebar: f.state.handleOpenSidebar,
    });
    f.owner.state = host;
    const sent = message(host.sessionKey, "new");
    sent.detail.content = [{ type: "text", text: "Start a conversation" }];
    f.dispatch(MCP_APP_MESSAGE_EVENT, sent.detail);
    const frame = await dispatched.promise;

    await handleAbortChat(host, { preserveDraft: true });
    expect(requestSignal?.aborted).toBe(true);
    pending.handleResponse({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { key: "agent:main:created", runStarted: true, runId: "created-run" },
    });

    expect(await sent.receipt.promise).toBe(true);
    expect(sent.respond).toHaveBeenCalledExactlyOnceWith(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    expect(pending.hasPending).toBe(false);
    expect(f.state.handleSendChat).not.toHaveBeenCalled();
  });

  it.each(["retirement", "Stop", "agent change", "selection change"] as const)(
    "does not create a conversation after %s while its handler loads",
    async (interruption) => {
      const f = fixture();
      const host = Object.assign(makeChatHost({ client: f.client, sessionKey: "global" }), {
        assistantAgentId: "main",
        handleSendChat: f.state.handleSendChat,
        handleOpenSidebar: f.state.handleOpenSidebar,
      });
      f.owner.state = host;
      const create = vi.fn(async () => null);
      Object.assign(f.context, {
        router: { getState: () => ({ location: "/chat/global" }) },
        sessions: { createResult: create },
        config: {},
      });
      const sent = message("global", "new");
      sent.detail.content = [{ type: "text", text: "Start a conversation" }];
      f.dispatch(MCP_APP_MESSAGE_EVENT, sent.detail);
      if (interruption === "retirement") {
        f.cleanup();
      } else if (interruption === "Stop") {
        await handleAbortChat(host, { preserveDraft: true });
      } else if (interruption === "agent change") {
        host.assistantAgentId = "replacement";
      } else {
        f.agentSelection.intentRevision++;
      }
      expect(await sent.receipt.promise).toBe(false);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("continues a claimed new-conversation request when its pane parks during loading", async () => {
    const f = fixture();
    const create = vi.fn(async () => null);
    Object.assign(f.context, {
      router: { getState: () => ({ location: "/chat/one" }) },
      sessions: { createResult: create },
      config: {},
    });
    const sent = message(f.state.sessionKey, "new");
    sent.detail.content = [{ type: "text", text: "Start a conversation" }];
    f.dispatch(MCP_APP_MESSAGE_EVENT, sent.detail);
    f.owner.presented = false;
    await sent.receipt.promise;
    expect(create).toHaveBeenCalledOnce();
  });

  it("retains resource attachment, file viewer, and hidden-pane context contracts", () => {
    const f = fixture();
    const resource = {
      type: "resource_link" as const,
      uri: "cad://part/1",
      name: "Bolt",
      title: "Hex/bolt",
    };
    expect(
      f.dispatch(MCP_APP_RESOURCE_MENTION_EVENT, {
        sessionKey: f.state.sessionKey,
        serverName: "parts",
        agentId: "main",
        resource,
      }).defaultPrevented,
    ).toBe(true);
    expect(f.state.chatAttachments[0]).toMatchObject({ fileName: "Hex-bolt.txt", origin: "file" });
    const respond = vi.fn();
    expect(
      f.dispatch(MCP_APP_FILE_OPEN_EVENT, {
        sessionKey: f.state.sessionKey,
        viewId: "view-one",
        path: "parts/bolt.stl",
        name: "bolt.stl",
        respond,
      }).defaultPrevented,
    ).toBe(true);
    expect(f.owner.openFile).toHaveBeenCalledWith("parts/bolt.stl");
    expect(respond).toHaveBeenCalledWith(true);
    f.owner.presented = false;
    const view = document.createElement("mcp-app-view");
    view.title = "Parts tray";
    f.element.append(view);
    view.dispatchEvent(
      new CustomEvent(MCP_APP_CONTEXT_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          sessionKey: f.state.sessionKey,
          viewId: "view-one",
          state: { updateId: "revision", content: [{ type: "text", text: "Selected bolt" }] },
        },
      }),
    );
    expect(readMcpAppContexts(f.client, f.state.sessionKey, "main")).toMatchObject([
      { title: "Parts tray", viewId: "view-one", state: { updateId: "revision" } },
    ]);
  });

  it("retires pane listeners with their owner and reads the current owner after remount", () => {
    const f = fixture();
    f.cleanup();
    expect(f.dispatch(MCP_APP_OPEN_EVENT, f.launch).defaultPrevented).toBe(false);
    f.dispatch(WIDGET_PROMPT_EVENT, { text: "not delivered" });
    expect(f.state.handleSendChat).not.toHaveBeenCalled();
    const next = { ...f.owner, state: { ...f.state, handleSendChat: vi.fn(async () => {}) } };
    f.setCurrent(next);
    f.mount();
    f.dispatch(WIDGET_PROMPT_EVENT, { text: "  delivered once  " });
    expect(next.state.handleSendChat).toHaveBeenCalledExactlyOnceWith("delivered once");
    expect(f.state.handleSendChat).not.toHaveBeenCalled();
  });
});
