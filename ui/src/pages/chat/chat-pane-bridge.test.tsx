/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import type { ChatPaneProps } from "./chat-pane.tsx";
import "./chat-pane.tsx";
import { discardPrewarmedChatSnapshot, prewarmChatSnapshot } from "./chat-snapshot-prewarm.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import * as snapshotDatabase from "./session-snapshot-database.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { CHAT_SNAPSHOT_PROJECTION_VERSION } from "./session-snapshot-record.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

function mountedFixture(
  id: string,
  row: Partial<Parameters<typeof createMountedPanes>[0][number]> = {},
) {
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  const sessionKey = `agent:main:${id}`;
  const fixture = createMountedPanes([
    { key: sessionKey, kind: "direct", sessionId: id, updatedAt: 1, ...row },
  ]);
  return {
    ...fixture,
    sessionKey,
    render: (props: Partial<ChatPaneProps> = {}) =>
      mountPane(fixture.context, { paneId: id, sessionKey, ...props }),
  };
}

function mountPane(context: ApplicationContext, props: Partial<ChatPaneProps>) {
  const container = document.body.appendChild(createApplicationContextProvider(context));
  const pane = Object.assign(document.createElement("openclaw-chat-pane"), props);
  container.append(pane);
  onTestFinished(() => container.remove());
  return { container, pane };
}

const composerSelector = ".agent-chat__composer-combobox textarea";
it("applies a route draft and its focus cue to an already mounted native pane", async () => {
  const view = mountedFixture("bridge-draft").render({ active: true, presented: true });
  const { pane } = view;
  const textarea = await waitForSolid(() =>
    expectDefined(view.container.querySelector<HTMLTextAreaElement>(composerSelector), "composer"),
  );
  Object.assign(pane, { draft: "What can you do?", focusComposer: true });
  await pane.updateComplete;
  expect(textarea.value).toBe("What can you do?");
  expect(document.activeElement).toBe(textarea);
  expect(textarea.closest(".agent-chat__input")?.classList).toContain(
    "agent-chat__input--prefill-attention",
  );
});

it("updates held Send as a mounted composer's draft changes between commands and ordinary input", async () => {
  const fixture = mountedFixture("held-send");
  const client = expectDefined(fixture.context.gateway.snapshot.client, "recovering client");
  Object.defineProperty(client, "recoveryScopeReady", { value: false });
  const container = document.body.appendChild(createApplicationContextProvider(fixture.context));
  onTestFinished(() => container.remove());
  const pane = fixture.mount(fixture.sessionKey);
  container.appendChild(pane.element);
  await pane.updateComplete;
  const sendChat = vi.spyOn(pane.state, "handleSendChat").mockResolvedValue(undefined);
  pane.state.handleChatDraftChange("/stop");
  await pane.updateComplete;
  const input = expectDefined(
    pane.querySelector<HTMLTextAreaElement>(composerSelector),
    "composer",
  );
  const send = expectDefined(pane.querySelector<HTMLButtonElement>(".chat-send-btn--send"), "send");
  const edit = async (draft: string) => {
    input.value = draft;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await pane.updateComplete;
    expect(pane.querySelector(composerSelector)).toBe(input);
  };

  expect(send.disabled).toBe(false);
  await edit("Keep this ordinary draft");
  expect(input.value).toBe("Keep this ordinary draft");
  expect(send.disabled).toBe(true);
  send.click();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(sendChat).not.toHaveBeenCalled();

  await edit("/approve approval-123 allow-once");
  expect(send.disabled).toBe(false);
  send.click();
  expect(sendChat).toHaveBeenCalledOnce();
});

it("replaces the command provider while document-hidden rendering is parked", async () => {
  let visibility: DocumentVisibilityState = "visible";
  const visibilitySpy = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  onTestFinished(() => visibilitySpy.mockRestore());
  const { sessionKey, render } = mountedFixture("bridge-board-provider");
  const first = createMockBoardProvider(sessionKey);
  const second = createMockBoardProvider(sessionKey);
  const subscribe = vi.spyOn(second.events, "subscribe");
  const view = render({ boardProvider: first });
  const { pane } = view;
  await pane.updateComplete;
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  pane.boardProvider = second;
  await waitForSolid(() => expect(subscribe).toHaveBeenCalledOnce());
  second.emitCommand({ kind: "focus_tab", tabId: "research" });
  expect(loadSettings().boardSessionViews?.[sessionKey]?.activeTabId).toBe("research");
  first.emitCommand({ kind: "focus_tab", tabId: "main" });
  expect(loadSettings().boardSessionViews?.[sessionKey]?.activeTabId).toBe("research");
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await pane.updateComplete;
});

it("opens provider findings through the mounted pane's first rendered frame", async () => {
  const review = {
    id: "bridge-review",
    runId: "bridge-paused-run",
    canContinue: true,
    explanation: "The agent tried to modify a synthetic file outside the selected project.",
    continuationMessage: "Continue only inside the selected project.",
  };
  const view = mountedFixture("bridge-provider-review", {
    agentId: "main",
    providerReview: review,
  }).render({ active: true });
  const dialog = () => view.container.querySelector("openclaw-modal-dialog");
  const reviewButton = await waitForSolid(() =>
    expectDefined(
      view.container.querySelector<HTMLButtonElement>(".chat-provider-review button"),
      "provider review",
    ),
  );
  reviewButton.click();
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(dialog()?.textContent).toContain(review.explanation);
    expect(dialog()?.querySelector("blockquote")?.textContent).toBe(review.continuationMessage);
  });
  expectDefined(
    view.container.querySelector<HTMLButtonElement>("openclaw-modal-actions button"),
    "modal action",
  ).click();
  await waitForSolid(() => expect(dialog()).toBeNull());
  expect(reviewButton.isConnected).toBe(true);
  reviewButton.click();
  await waitForSolid(() => expect(dialog()?.textContent).toContain(review.explanation));
});

it.each(["ready", "unavailable"] as const)(
  "admits the first pane from a pending snapshot, bounded at 100ms (%s)",
  async (outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fixture = mountedFixture("snapshot-admission");
    const gateway = fixture.context.gateway;
    gateway.snapshot.phase = "connecting";
    Object.defineProperty(gateway.snapshot.client, "offlineRecoveryScope", { value: "account-a" });
    const key = resolveChatSnapshotKey(
      {
        settings: gateway.connection,
        client: gateway.snapshot.client,
        hello: gateway.snapshot.hello,
        agentsList: fixture.context.agents.state.agentsList,
      },
      { sessionKey: fixture.sessionKey },
    );
    const read = createDeferred<unknown>();
    const disk = vi
      .spyOn(snapshotDatabase, "readStoredChatSnapshotRecord")
      .mockReturnValue(read.promise);
    onTestFinished(async () => {
      read.resolve(undefined);
      discardPrewarmedChatSnapshot();
      disk.mockRestore();
      vi.useRealTimers();
    });
    const prepared = prewarmChatSnapshot(key);
    const view = fixture.render({ active: true, sessionSnapshotStore: new SessionSnapshotStore() });
    flush();
    await vi.advanceTimersByTimeAsync(99);
    flush();
    expect(view.pane.querySelector(".chat-pane__header")).toBeNull();
    if (outcome === "ready") {
      read.resolve({
        projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
        savedAt: 1,
        sessionKey: key,
        sessionId: "snapshot-session",
        snapshot: {
          messages: [{ role: "assistant", content: "Stored conversation" }],
          pagination: { hasMore: false, completeSnapshot: true },
          sessionId: "snapshot-session",
          sessionState: {
            archived: true,
            unarchiveAllowed: false,
            parentSession: { key: "agent:main:parent", title: "Stored parent" },
          },
        },
      });
      await prepared;
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(view.pane.querySelector(".chat-pane__header")).not.toBeNull();
      expect(view.pane.querySelector(".chat-pane__parent-session")?.textContent).toContain(
        "Stored parent",
      );
      expect(view.pane.querySelector(".agent-chat__disabled-banner--replacement")).not.toBeNull();
      expect(view.pane.querySelector(".agent-chat__input")).toBeNull();
      expect(view.pane.textContent).toContain("Stored conversation");
    } else {
      await vi.advanceTimersByTimeAsync(1);
      flush();
      expect(view.pane.querySelector(".chat-pane__header")).not.toBeNull();
      read.resolve(undefined);
      await prepared;
    }
  },
);
