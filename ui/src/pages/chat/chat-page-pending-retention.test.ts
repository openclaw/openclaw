/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createRouter } from "@openclaw/uirouter";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { settleChatPage, stubMatchMedia } from "./chat-page.test-support.ts";
import "./chat-page.tsx";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { nativeHistoryMessage } from "./chat-pane.test-support.ts";
import type { ChatPaneElement } from "./chat-pane.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { PendingSessionCreate } from "./pending-session-create-lazy.ts";

// These page-only fixtures bypass the selector/router that prepares the pending view.
beforeAll(async () => {
  await PendingSessionCreate.preload();
});

beforeEach(() => {
  installTranscriptDomMocks();
  stubMatchMedia(false);
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("indexedDB", new IDBFactory());
});

afterEach(resetTranscriptTestDom);

it.each(["admission", "rollback"] as const)(
  "keeps the previous chat mounted without redundant startup through creation and %s",
  async (outcome) => {
    const previousKey = "agent:main:main";
    const greeting = "Hi, I’m New agent. Happy to help.";
    const agentId = "bot-new-agent";
    const sessionKey = `agent:${agentId}:main`;
    const rows: GatewaySessionRow[] = [
      { key: previousKey, agentId: "main", sessionId: "previous", kind: "direct", updatedAt: 1 },
    ];
    const startupKeys: unknown[] = [];
    const { context } = createMountedPanes(rows, "main", undefined, {
      "chat.startup": async (_method, raw) => {
        const key = asOptionalRecord(raw)?.sessionKey;
        startupKeys.push(key);
        const row = rows.find((entry) => entry.key === key);
        return {
          messages: [
            nativeHistoryMessage(2, key === previousKey ? "Previous transcript" : greeting),
          ],
          sessionInfo: row,
          sessionId: row?.sessionId,
        };
      },
    });
    const router = createRouter({ routes: [] });
    Object.assign(context, { basePath: "", router, navigate: vi.fn(), replace: vi.fn() });
    await context.agents.ensureList();
    const container = document.body.appendChild(createApplicationContextProvider(context));
    const page = Object.assign(document.createElement("openclaw-chat-page"), {
      data: { sessionKey: previousKey },
    });
    container.append(page);
    try {
      await settleChatPage(page);
      const previousPane = expectDefined(
        page.querySelector<ChatPaneElement>("openclaw-chat-pane"),
        "previous pane",
      );
      const visible = () => page.querySelector(".chat-pane-cache__pane--visible");
      const expectPrevious = (hidden: boolean) => {
        expect.soft(previousPane.isConnected).toBe(true);
        expect.soft(previousPane.getAttribute("aria-hidden")).toBe(String(hidden));
        expect.soft(previousPane.hasAttribute("inert")).toBe(hidden);
      };
      // History can wait two seconds for its initial stored snapshot before requesting startup.
      await vi.waitFor(() => expect(previousPane.transcriptReady).toBe(true), { timeout: 5_000 });
      await settleChatPage(page);
      expect(page.textContent).toContain("Previous transcript");
      expect(startupKeys).toEqual([previousKey]);
      const creation = { sessionKey, admitted: false };
      context.agents.state.pendingAgent = { id: agentId, name: "New agent" };
      const clear = context.chatSubmissions.beginCreate({
        creation,
        displayName: "New agent",
        message: null,
        canDisplay: () => true,
      });
      page.data = { sessionKey, agentId, creation, face: "chat" };
      await settleChatPage(page);
      await settleChatPage(page);
      expectPrevious(true);
      expect(startupKeys).toEqual([previousKey]);

      context.agents.state.pendingAgent = undefined;
      if (outcome === "admission") {
        rows.push({ key: sessionKey, agentId, sessionId: "created", kind: "direct", updatedAt: 2 });
        creation.admitted = true;
      } else {
        page.data = { sessionKey: previousKey };
      }
      clear();
      await settleChatPage(page);
      await settleChatPage(page);
      await waitForSolid(() =>
        expect(visible()?.textContent).toContain(
          outcome === "admission" ? greeting : "Previous transcript",
        ),
      );
      const panes = [...page.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")];
      expect.soft(panes.find((pane) => pane.sessionKey === previousKey)).toBe(previousPane);
      expectPrevious(outcome === "admission");
      expect.soft(panes).toHaveLength(outcome === "admission" ? 2 : 1);
      expect(startupKeys).toEqual(
        outcome === "admission" ? [previousKey, sessionKey] : [previousKey],
      );
    } finally {
      container.remove();
      router.stop();
    }
  },
);
