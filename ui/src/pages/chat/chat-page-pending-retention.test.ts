/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createRouter } from "@openclaw/uirouter";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
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

afterEach(() => {
  vi.restoreAllMocks();
  resetTranscriptTestDom();
});

it.each(["admission", "rollback"] as const)(
  "keeps the previous chat mounted without redundant startup through creation and %s",
  async (outcome) => {
    const previousKey = "agent:main:main";
    const agentId = "bot-new-agent";
    const sessionKey = `agent:${agentId}:main`;
    const rows: GatewaySessionRow[] = [
      { key: previousKey, agentId: "main", sessionId: "previous", kind: "direct", updatedAt: 1 },
    ];
    const startupKeys: unknown[] = [];
    const fixture = createMountedPanes(rows, "main", undefined, {
      "chat.startup": async (_method, raw) => {
        const key = asOptionalRecord(raw)?.sessionKey;
        startupKeys.push(key);
        const row = rows.find((entry) => entry.key === key);
        return {
          messages: [
            nativeHistoryMessage(
              2,
              key === previousKey ? "Previous transcript" : "Hi, I’m New agent. Happy to help.",
            ),
          ],
          sessionInfo: row,
          sessionId: row?.sessionId,
        };
      },
    });
    const { context } = fixture;
    const router = createRouter({ routes: [] });
    Object.assign(context, { basePath: "", router, navigate: vi.fn(), replace: vi.fn() });
    await context.agents.ensureList();
    const provider = createSolidApplicationContextProvider(context);
    const container = document.body.appendChild(createApplicationContextProvider(context));
    const view = mountSolid(
      () =>
        Object.assign(document.createElement("openclaw-chat-page"), {
          data: { sessionKey: previousKey },
        }),
      {
        container,
        wrapper: provider.wrapper,
      },
    );
    try {
      const page = expectDefined(
        container.querySelector<HTMLElementTagNameMap["openclaw-chat-page"]>("openclaw-chat-page"),
        "chat page",
      );
      await vi.waitFor(() => expect(page.textContent).toContain("Previous transcript"));
      const previousPane = expectDefined(
        page.querySelector<ChatPaneElement>("openclaw-chat-pane"),
        "previous pane",
      );
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
      expect.soft(previousPane.isConnected).toBe(true);
      expect.soft(previousPane.getAttribute("aria-hidden")).toBe("true");
      expect.soft(previousPane.hasAttribute("inert")).toBe(true);
      expect(page.querySelector(".chat-pane-cache__pane--visible")?.textContent).not.toContain(
        "Previous transcript",
      );
      expect(page.querySelector("openclaw-pending-session-create")).not.toBeNull();
      expect(
        page.querySelector(".chat-pane-cache__pane--visible .chat-text")?.textContent?.trim(),
      ).toBe("Hi, I’m New agent. Happy to help.");
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
      await vi.waitFor(() =>
        expect(page.querySelector(".chat-pane-cache__pane--visible")?.textContent).toContain(
          outcome === "admission" ? "Hi, I’m New agent. Happy to help." : "Previous transcript",
        ),
      );
      expect(page.querySelector("openclaw-pending-session-create")).toBeNull();
      expect(
        [...page.querySelectorAll(".chat-text")].filter(
          (entry) => entry.textContent?.trim() === "Hi, I’m New agent. Happy to help.",
        ),
      ).toHaveLength(outcome === "admission" ? 1 : 0);
      expect
        .soft(
          [...page.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].find(
            (pane) => pane.sessionKey === previousKey,
          ),
        )
        .toBe(previousPane);
      expect
        .soft(previousPane.getAttribute("aria-hidden"))
        .toBe(outcome === "admission" ? "true" : "false");
      expect.soft(previousPane.hasAttribute("inert")).toBe(outcome === "admission");
      expect
        .soft(page.querySelectorAll("openclaw-chat-pane"))
        .toHaveLength(outcome === "admission" ? 2 : 1);
      expect(startupKeys).toEqual(
        outcome === "admission" ? [previousKey, sessionKey] : [previousKey],
      );
    } finally {
      view.unmount();
      container.remove();
      router.stop();
    }
  },
);
