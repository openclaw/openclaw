import { createRoot } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import { MCP_APP_RESOURCE_MENTION_EVENT } from "../../components/mcp-app-resources.tsx";
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
import { createChatPaneMcpApps, type ChatPaneMcpAppOwner } from "./chat-pane-mcp-app.ts";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const element = document.createElement("div");
  const client = createTestGatewayClient(async () => ({}));
  const { gateway } = createApplicationGateway();
  Object.assign(gateway.snapshot, { phase: "connected", client, sessionKey: "agent:main:one" });
  const context = { gateway } as ApplicationContext;
  const state: ChatPaneMcpAppOwner["state"] = {
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
    replaceAttachments: (attachments) => {
      state.chatAttachments = attachments;
    },
    openFile: vi.fn(),
  };
  let current: ChatPaneMcpAppOwner | null = owner;
  let syncLaunch!: () => void;
  function mount() {
    const dispose = createRoot((stop) => {
      syncLaunch = createChatPaneMcpApps({ element, current: () => current });
      return stop;
    });
    onTestFinished(dispose);
    return dispose;
  }
  const cleanup = mount();
  onTestFinished(() => releaseChatAttachmentPayloads(state.chatAttachments));
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
  const dispatch = (name: string, payload: object, accepted = true, target = element) => {
    const detail = { sessionKey: state.sessionKey, ...payload };
    const event = new CustomEvent(name, {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(accepted);
  };
  return {
    element,
    client,
    context,
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

function message(target: "active" | "new" = "active") {
  const receipt = createDeferred<boolean>();
  const respond = vi.fn((accepted: boolean) => receipt.resolve(accepted));
  const detail: McpAppMessageEventDetail = {
    sessionKey: f.state.sessionKey,
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

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});

function expectLaunch(accepted: boolean, overrides: Partial<McpAppOpenDetail> = {}) {
  f.dispatch(MCP_APP_OPEN_EVENT, { ...f.launch, ...overrides }, accepted);
}

it("claims only the presented matching owner and retains per-launch synchronization", () => {
  f.owner.presented = false;
  expectLaunch(false);
  f.owner.presented = true;
  expectLaunch(false, { sessionKey: "other" });
  expectLaunch(false, { owner: createTestGatewayClient(async () => ({})) });
  expect(f.state.handleOpenSidebar).not.toHaveBeenCalled();
  expectLaunch(true);
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

it.each([true, false])(
  "acknowledges and retains active payload only with outbox custody=%s",
  async (admitted) => {
    const pending = createDeferred();
    const sent = message();
    let attachments: readonly ChatAttachment[] = [];
    f.state.handleSendChat = vi.fn((_text, options) => {
      attachments = options?.attachmentsOverride ?? [];
      if (admitted) {
        options?.onOutboxAdmitted?.();
      }
      return pending.promise;
    });
    f.dispatch(MCP_APP_MESSAGE_EVENT, sent.detail);
    expect(sent.respond).not.toHaveBeenCalled();
    expect(f.state.handleSendChat).toHaveBeenCalledWith(
      "Compare parts",
      expect.objectContaining({ attachmentsOverride: attachments }),
    );
    expect(attachments).toContainEqual(expect.objectContaining({ fileName: "Part measurements" }));
    if (admitted) {
      f.setCurrent(null);
      f.cleanup();
      pending.resolve();
    } else {
      pending.reject(new Error("rejected"));
    }
    expect(await sent.receipt.promise).toBe(admitted);
    expect(getChatAttachmentDataUrl(attachments[0]!)).toEqual(admitted ? expect.any(String) : null);
    expect(sent.respond).toHaveBeenCalledOnce();
    releaseChatAttachmentPayloads(attachments);
  },
);

it("delegates new-conversation delivery and acknowledges its existing owner result", async () => {
  const pending = createDeferred<boolean>();
  const sent = message("new");
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
  const resource = {
    type: "resource_link" as const,
    uri: "cad://part/1",
    name: "Bolt",
    title: "Hex/bolt",
  };
  f.dispatch(MCP_APP_RESOURCE_MENTION_EVENT, { serverName: "parts", agentId: "main", resource });
  expect(f.state.chatAttachments[0]).toMatchObject({ fileName: "Hex-bolt.txt", origin: "file" });
  const respond = vi.fn();
  f.dispatch(MCP_APP_FILE_OPEN_EVENT, {
    viewId: "view-one",
    path: "parts/bolt.stl",
    name: "bolt.stl",
    respond,
  });
  expect(f.owner.openFile).toHaveBeenCalledWith("parts/bolt.stl");
  expect(respond).toHaveBeenCalledWith(true);
  f.owner.presented = false;
  const view = document.createElement("mcp-app-view");
  view.title = "Parts tray";
  f.element.append(view);
  f.dispatch(
    MCP_APP_CONTEXT_EVENT,
    {
      viewId: "view-one",
      state: { updateId: "revision", content: [{ type: "text", text: "Selected bolt" }] },
    },
    false,
    view,
  );
  expect(readMcpAppContexts(f.client, f.state.sessionKey, "main")).toMatchObject([
    { title: "Parts tray", viewId: "view-one", state: { updateId: "revision" } },
  ]);
});

it("retires pane listeners with their owner and reads the current owner after remount", () => {
  f.cleanup();
  expectLaunch(false);
  f.dispatch(WIDGET_PROMPT_EVENT, { text: "not delivered" }, false);
  expect(f.state.handleSendChat).not.toHaveBeenCalled();
  const next = { ...f.owner, state: { ...f.state, handleSendChat: vi.fn(async () => {}) } };
  f.setCurrent(next);
  f.mount();
  f.dispatch(WIDGET_PROMPT_EVENT, { text: "  delivered once  " }, false);
  expect(next.state.handleSendChat).toHaveBeenCalledExactlyOnceWith("delivered once");
  expect(f.state.handleSendChat).not.toHaveBeenCalled();
});
