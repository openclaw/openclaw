/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-attachment-handoff.test/"} */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { registerMcpAppUnmountTarget } from "../../components/mcp-app-unmount.ts";

// mock-isolation: Fake panes own staged-attachment callbacks during MCP teardown; real tag registration would replace that lifecycle.
vi.mock("./chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("./chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { settleChatPage, setNavigationContext, stubMatchMedia } from "./chat-page.test-support.ts";
import "./chat-page.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  sessionKey: string;
  onClosePane?: (paneId: string) => void;
  discardStagedAttachments?: () => void;
  resumeStagedAttachments?: () => void;
};

async function split(page: HTMLElementTagNameMap["openclaw-chat-page"]) {
  window.dispatchEvent(
    new CustomEvent(UI_COMMAND_EVENT, {
      cancelable: true,
      detail: { command: { kind: "split", direction: "right", sessionKey: "main" } },
    }),
  );
  await settleChatPage(page);
}

describe("chat page staged attachment rebound", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("reactivates a closed pane when delayed MCP teardown rebounds to the same owner", async () => {
    const page = document.createElement("openclaw-chat-page");
    setNavigationContext(page);
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await settleChatPage(page);
    await split(page);

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
    onTestFinished(registerMcpAppUnmountTarget(mcpApp));
    closingPane.append(mcpApp);

    closingPane.onClosePane?.(closingPane.paneId);
    await settleChatPage(page);
    expect(discard).toHaveBeenCalledOnce();
    expect(closingPane.isConnected).toBe(true);

    await split(page);
    expect(resume).toHaveBeenCalled();

    teardown.resolve();
    await expect.poll(() => restartAfterTeardown).toHaveBeenCalledOnce();
    expect(page.querySelectorAll<RenderedPane>("openclaw-chat-pane")[1]).toBe(closingPane);
  });
});
