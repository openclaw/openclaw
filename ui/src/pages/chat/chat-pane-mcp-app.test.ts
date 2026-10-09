import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import { MCP_APP_RESOURCE_MENTION_EVENT } from "../../components/mcp-app-resources.ts";
import {
  MCP_APP_CONTEXT_EVENT,
  MCP_APP_FILE_OPEN_EVENT,
  MCP_APP_MESSAGE_EVENT,
  WIDGET_PROMPT_EVENT,
  type McpAppMessageEventDetail,
} from "../../components/mcp-app-security.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { readMcpAppContexts } from "../../lib/mcp-app-context.ts";
import * as appMessages from "../../lib/mcp-app-message.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { ChatPaneMcpAppController, type ChatPaneMcpAppOwner } from "./chat-pane-mcp-app.ts";

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
  const context = { gateway: gateway.gateway } as ApplicationContext;
  const state: ChatPaneMcpAppOwner["state"] = {
    sessionKey: "agent:main:one",
    assistantAgentId: "main",
    chatAttachments: [],
    hello: null,
    requestUpdate: vi.fn(),
    handleSendChat: vi.fn(async () => {}),
    handleOpenSidebar: vi.fn(),
  };
  const owner: ChatPaneMcpAppOwner = {
    context,
    state,
    presented: true,
    agentId: "fallback",
    openFile: vi.fn(),
  };
  let current: ChatPaneMcpAppOwner | null = owner;
  const controller = new ChatPaneMcpAppController({ element, current: () => current });
  const cleanup = controller.subscribe();
  cleanups.push(cleanup, () => releaseChatAttachmentPayloads(state.chatAttachments));
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
    state,
    owner,
    controller,
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

describe("MCP app pane controller", () => {
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
    f.controller.syncLaunch();
    f.controller.syncLaunch();
    expect(f.state.handleOpenSidebar).toHaveBeenCalledTimes(2);
    expect(f.state.handleOpenSidebar).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileTab: { id: "mcp-app:parts/tray:app", label: "Parts tray" } }),
    );
    f.owner.launch = { ...f.launch, deepLink: "/second" };
    f.controller.syncLaunch();
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
    expect(create).toHaveBeenCalledWith(f.context, "main", sent.detail);
    expect(f.state.handleSendChat).not.toHaveBeenCalled();
    expect(sent.respond).not.toHaveBeenCalled();
    pending.resolve(false);
    expect(await sent.receipt.promise).toBe(false);
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
    expect(f.state.requestUpdate).toHaveBeenCalledOnce();
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

  it("cleans up every pane listener and reads the current owner when resubscribed", () => {
    const f = fixture();
    const remove = vi.spyOn(f.element, "removeEventListener");
    f.cleanup();
    expect(remove.mock.calls.map(([name]) => name)).toEqual([
      MCP_APP_RESOURCE_MENTION_EVENT,
      MCP_APP_MESSAGE_EVENT,
      MCP_APP_FILE_OPEN_EVENT,
      MCP_APP_CONTEXT_EVENT,
      MCP_APP_OPEN_EVENT,
      WIDGET_PROMPT_EVENT,
    ]);
    expect(f.dispatch(MCP_APP_OPEN_EVENT, f.launch).defaultPrevented).toBe(false);
    f.dispatch(WIDGET_PROMPT_EVENT, { text: "not delivered" });
    expect(f.state.handleSendChat).not.toHaveBeenCalled();
    const next = { ...f.owner, state: { ...f.state, handleSendChat: vi.fn(async () => {}) } };
    f.setCurrent(next);
    cleanups.push(f.controller.subscribe());
    f.dispatch(WIDGET_PROMPT_EVENT, { text: "  delivered once  " });
    expect(next.state.handleSendChat).toHaveBeenCalledExactlyOnceWith("delivered once");
    expect(f.state.handleSendChat).not.toHaveBeenCalled();
  });
});
