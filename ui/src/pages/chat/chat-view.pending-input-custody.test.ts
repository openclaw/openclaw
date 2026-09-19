/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import * as chatThreadBuild from "./chat-thread-build.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import { resetTranscriptSession } from "./components/chat-thread-interactions.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderChatView(overrides: Partial<Parameters<typeof renderChat>[0]> = {}) {
  const container = document.createElement("div");
  render(renderChat(createChatProps(overrides)), container);
  return container;
}

it.each(["pending custody", "transcript"] as const)(
  "hides the retained queue copy represented by %s without hiding an identical new send",
  (source) => {
    const historyState = makeChatHost({ currentSessionId: "retained-input-session" });
    const message = {
      role: "user",
      content: "Check the deployment notes",
      timestamp: 100,
      idempotencyKey: "retained-run:user",
    };
    if (source === "pending custody") {
      applyChatPendingInputs(historyState, { total: 0, items: [] });
      applyChatPendingInputs(historyState, {
        total: 1,
        items: [
          {
            id: "retained-input",
            runId: "retained-run",
            acceptedAt: 100,
            state: "queued",
            message,
          },
        ],
      });
    }
    const queue = ["before", "retained", "new"].map((id, index) => ({
      id,
      text: message.content,
      createdAt: 100 + index,
      sendRunId: `${id}-run`,
      sendState: "waiting-reconnect" as const,
    }));
    const onQueueRemove = vi.fn();
    const onQueueMove = vi.fn();
    const container = renderChatView({
      historyState,
      messages: source === "transcript" ? [message] : [],
      queue,
      onQueueRemove,
      onQueueMove,
    });

    const rows = container.querySelectorAll(".chat-queue__item");
    expect([...rows].map((row) => row.getAttribute("data-chat-queue-item"))).toEqual(
      source === "pending custody"
        ? ["before", "pending-input:retained-input", "new"]
        : ["before", "new"],
    );
    const grips = [...container.querySelectorAll<HTMLButtonElement>(".chat-queue__grip")];
    expect(grips).toHaveLength(source === "pending custody" ? 3 : 2);
    expect(grips.every((grip) => grip.disabled)).toBe(true);
    grips[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onQueueMove).not.toHaveBeenCalled();
    rows[rows.length - 1]?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
    expect(onQueueRemove).toHaveBeenCalledWith("new");
    expect(queue).toHaveLength(3);
  },
);

it("keeps history cached while worker setup updates the composer custody notice", async () => {
  const sessionKey = "agent:main:worker-setup";
  const historyState = makeChatHost({ sessionKey, currentSessionId: "worker-setup-session" });
  applyChatPendingInputs(historyState, { total: 0, items: [] });
  applyChatPendingInputs(historyState, {
    total: 1,
    items: [
      {
        id: "queued-follow-up",
        runId: "queued-run",
        acceptedAt: 3_000,
        state: "queued",
        message: { role: "user", content: "Queued follow-up", timestamp: 3_000 },
      },
    ],
  });
  const timing = { generation: 1, createdAtMs: 1, updatedAtMs: 1, stateChangedAtMs: 1 };
  const props = createChatProps({
    historyState,
    sessionKey,
    messages: [
      { role: "user", content: "Earlier request", timestamp: 1_000 },
      { role: "assistant", content: "Earlier reply", timestamp: 2_000 },
    ],
    selectedSession: {
      key: sessionKey,
      kind: "direct",
      updatedAt: 1,
      placement: { state: "requested", ...timing },
    },
  });
  const container = document.body.appendChild(document.createElement("div"));
  resetTranscriptSession(props.paneId);
  const buildSpy = vi.spyOn(chatThreadBuild, "buildChatItems");
  const rerender = () => {
    render(renderChat(props), container);
    props.transcript.hostUpdated();
  };
  try {
    rerender();
    props.transcript.hostConnected();
    await vi.waitFor(() => expect(buildSpy).toHaveBeenCalledOnce());
    const custodyRow = expectDefined(
      container.querySelector(".agent-chat__composer-shell .chat-queue__item"),
      "composer custody row",
    );
    expect(custodyRow.textContent).toContain("Queued follow-up");
    expect(custodyRow.textContent).toContain("Received · waiting for worker setup");
    expect(container.querySelector(".agent-chat__transcript .chat-queue__item")).toBeNull();

    rerender();
    expect(buildSpy).toHaveBeenCalledOnce();

    props.selectedSession = {
      ...props.selectedSession,
      key: sessionKey,
      kind: "direct",
      placement: {
        state: "active",
        ...timing,
        environmentId: "worker:fixture",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "base-manifest",
        remoteWorkspaceDir: "/worker/repo",
      },
    };
    rerender();
    expect(buildSpy).toHaveBeenCalledOnce();
    const updatedCustodyRow = expectDefined(
      container.querySelector(".agent-chat__composer-shell .chat-queue__item"),
      "updated composer custody row",
    );
    expect(updatedCustodyRow.textContent).not.toContain("Received · waiting for worker setup");
    expect(updatedCustodyRow.textContent).toContain("Queued follow-up");
  } finally {
    props.transcript.hostDisconnected();
  }
});
