/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-attachment-handoff.test/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";

// mock-isolation: Fake panes own staged-attachment callbacks during MCP teardown; real tag registration would replace that lifecycle.
vi.mock("./chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("./chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { settleChatPage, createChatPageSessions } from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  sessionKey: string;
  onClosePane?: (paneId: string) => void;
  discardStagedAttachments?: () => void;
  resumeStagedAttachments?: () => void;
};

function configure(page: ChatPage) {
  const context = {
    chatSubmissions: createChatSubmissions(),
    sessions: { ...createChatPageSessions(), patch: vi.fn() },
    placementStartup: { get: vi.fn(() => null), subscribe: () => () => undefined },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: {
      snapshot: { hello: null },
      setSessionKey: vi.fn(),
      subscribe: () => () => undefined,
    },
    navigate: vi.fn(),
    replace: vi.fn(),
    agentSelection: { state: { selectedId: "main" }, set: vi.fn() },
    chatAttachmentHandoff: {
      prepare: vi.fn(),
      consume: vi.fn(() => null),
      clearPane: vi.fn(),
      dispose: vi.fn(),
    },
  } as unknown as ApplicationContext;
  (page as unknown as { context: ApplicationContext }).context = context;
  page.data = { sessionKey: "main" };
}

describe("chat page staged attachment rebound", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("reactivates a closed pane when delayed MCP teardown rebounds to the same owner", async () => {
    const page = new ChatPage();
    configure(page);
    document.body.append(page);
    await settleChatPage(page);
    window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, {
        cancelable: true,
        detail: { command: { kind: "split", direction: "right", sessionKey: "main" } },
      }),
    );
    await settleChatPage(page);

    const closingPane = page.querySelectorAll<RenderedPane>("openclaw-chat-pane")[1]!;
    const discard = vi.fn();
    const resume = vi.fn();
    closingPane.discardStagedAttachments = discard;
    closingPane.resumeStagedAttachments = resume;
    const teardown = deferred();
    const mcpApp = document.createElement("mcp-app-view");
    const restartAfterTeardown = vi.fn();
    mcpApp.restartAfterTeardown = restartAfterTeardown;
    mcpApp.teardown = vi.fn(() => teardown.promise);
    closingPane.append(mcpApp);

    closingPane.onClosePane?.(closingPane.paneId);
    await settleChatPage(page);
    expect(discard).toHaveBeenCalledOnce();
    expect(closingPane.isConnected).toBe(true);

    window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, {
        cancelable: true,
        detail: { command: { kind: "split", direction: "right", sessionKey: "main" } },
      }),
    );
    await settleChatPage(page);
    expect(resume).toHaveBeenCalled();

    teardown.resolve();
    await expect.poll(() => restartAfterTeardown).toHaveBeenCalledOnce();
    expect(page.querySelectorAll<RenderedPane>("openclaw-chat-pane")[1]).toBe(closingPane);
  });
});
