/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderTranscriptSearch, toggleTranscriptSearch } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function requireElement(container: ParentNode, selector: string): HTMLElement {
  return expectDefined(container.querySelector<HTMLElement>(selector), selector);
}

describe("chat transcript replies", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  function replyMessages(
    client?: readonly [id: string, mode: string, displayName: string] | null,
    namedHuman = false,
  ) {
    const [id, mode, displayName] = client ?? [];
    return [
      {
        role: client ? "user" : "assistant",
        content: "The original answer",
        __openclaw: {
          id: "source-message",
          ...(namedHuman
            ? {
                senderId: "profile-alice",
                senderName: "Alice",
                senderIdentity: { type: "profile", id: "profile-alice" },
              }
            : {}),
          ...(client ? { transport: { clients: [{ id, mode, displayName }] } } : {}),
        },
        timestamp: 1_000,
      },
      {
        role: "user",
        content: "Follow up",
        __openclaw: { id: "reply-message", replyToId: "source-message" },
        timestamp: 2_000,
      },
    ] as const;
  }

  it.each([false, true])(
    "resolves persisted replies and owns their flash lifetime (reduced motion: %s)",
    async (reducedMotion) => {
      vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const props = threadProps("pane-reply-preview", "agent:main:main", [...replyMessages()]);
      render(renderChatThread(props, transcript), container);
      transcript.hostConnected();
      transcript.hostUpdated();
      await flushDeferredRowPrune();

      const preview = container.querySelector<HTMLButtonElement>(".chat-reply-preview--message");
      expect(preview?.textContent).toContain("Replying to Molty");
      expect(preview?.textContent).toContain("The original answer");
      expect(preview?.textContent).not.toContain("source-message");

      const sourceBubble = [...container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
        (bubble) => bubble.dataset.entryId === "source-message",
      )!;
      const duration = reducedMotion ? 1_000 : 1_200;
      vi.useFakeTimers();
      try {
        preview?.click();
        await Promise.resolve();
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
        sourceBubble.firstElementChild!.dispatchEvent(new Event("animationend", { bubbles: true }));
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
        vi.advanceTimersByTime(duration / 2);
        preview?.click();
        await Promise.resolve();
        vi.advanceTimersByTime(duration - 1);
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
        vi.advanceTimersByTime(1);
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(false);
        preview?.click();
        await Promise.resolve();
        transcript.hostDisconnected();
        expect(sourceBubble.classList.contains("chat-bubble--reply-target")).toBe(false);
      } finally {
        transcript.hostDisconnected();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["assistant", null, false, "Molty"],
    ["CLI", ["cli", "cli", "Release helper"], false, "via CLI (Release helper)"],
    ["RPC", ["gateway-client", "backend", "Build helper"], false, "via RPC (Build helper)"],
    ["named human via CLI", ["cli", "cli", "Release helper"], true, "Alice"],
  ] as const)(
    "hydrates an unloaded %s reply preview without inserting its source row",
    async (_source, client, namedHuman, senderLabel) => {
      const [sourceMessage, followUp] = replyMessages(client, namedHuman);
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      let resolvedMessage: unknown = undefined;
      const request = vi.fn();
      const open = vi.fn();
      const props = {
        ...threadProps("pane-reply-hydration", "agent:main:main", [followUp]),
        userId: "profile-viewer",
        userName: "Unrelated Viewer",
        replyMessageAccess: {
          revision: 0,
          navigationId: null,
          read: () => resolvedMessage,
          request,
          open,
        },
      };
      const rerender = () => {
        render(renderChatThread(props, transcript), container);
        transcript.hostUpdated();
      };
      try {
        rerender();
        transcript.hostConnected();
        await flushDeferredRowPrune();

        expect(request).toHaveBeenCalledWith("source-message");
        expect(container.querySelector("[data-entry-id='source-message']")).toBeNull();

        resolvedMessage = { ...sourceMessage, content: "The original message" };
        props.replyMessageAccess.revision += 1;
        rerender();

        const preview = container.querySelector<HTMLButtonElement>(".chat-reply-preview--message");
        expect(preview?.querySelector(".chat-reply-preview__label")?.textContent?.trim()).toBe(
          `Replying to ${senderLabel}`,
        );
        expect(preview?.textContent).toContain("The original message");
        expect(container.querySelector("[data-entry-id='source-message']")).toBeNull();
        preview?.click();
        expect(open).toHaveBeenCalledWith("source-message");
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it.each([false, true])(
    "opens folded work when a reply navigation loads its source (run frame: %s)",
    async (framed) => {
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const [sourceMessage, followUp] = replyMessages();
      const props = threadProps("pane-folded-history-reply", "agent:main:dashboard:reply", [
        followUp,
      ]);
      const open = vi.fn();
      props.replyMessageAccess = {
        revision: 0,
        navigationId: null,
        read: () => sourceMessage,
        request: vi.fn(),
        open,
      };
      const rerender = () => {
        render(renderChatThread(props, transcript), container);
        transcript.hostUpdated();
      };
      try {
        rerender();
        transcript.hostConnected();
        await flushDeferredRowPrune();
        requireElement(container, ".chat-reply-preview--message").click();
        expect(open).toHaveBeenCalledWith("source-message");
        props.replyMessageAccess.navigationId = "source-message";
        props.messages = [
          {
            role: "user",
            content: "Prepare an answer",
            timestamp: 0,
            ...(framed ? { __openclaw: { idempotencyKey: "source-run:user" } } : {}),
          },
          { ...sourceMessage, ...(framed ? { runId: "source-run" } : {}) },
          {
            role: "assistant",
            phase: "final_answer",
            content: "Final answer",
            timestamp: 1_500,
            ...(framed ? { runId: "source-run" } : {}),
          },
          followUp,
        ];
        rerender();
        await flushDeferredRowPrune();
        expect(
          requireElement(container, ".chat-work-group button").getAttribute("aria-expanded"),
        ).toBe("true");
        expect(requireElement(container, "[data-entry-id='source-message']").textContent).toContain(
          "The original answer",
        );
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it("clears search before navigating to a filtered reply target", async () => {
    const transcript = createTestTranscript();
    const searchContainer = document.body.appendChild(document.createElement("div"));
    const threadContainer = document.body.appendChild(document.createElement("div"));
    const open = vi.fn();
    const paneId = "pane-filtered-reply-navigation";
    const [sourceMessage, followUp] = replyMessages();
    const props = {
      ...threadProps(paneId, "agent:main:main", [
        sourceMessage,
        {
          ...followUp,
          __openclaw: {
            ...followUp["__openclaw"],
            replyToPreview: { text: "The original answer", senderLabel: "Molty" },
          },
        },
      ]),
      replyMessageAccess: {
        revision: 0,
        navigationId: null,
        read: () => undefined,
        request: vi.fn(),
        open,
      },
    };
    const rerender = () => {
      render(renderTranscriptSearch(paneId, rerender), searchContainer);
      render(
        renderChatThread({ ...props, onRequestUpdate: rerender }, transcript),
        threadContainer,
      );
      transcript.hostUpdated();
    };
    toggleTranscriptSearch(paneId, rerender);
    rerender();
    transcript.hostConnected();
    const input = searchContainer.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    input!.value = "Follow up";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushDeferredRowPrune();

    expect(threadContainer.querySelector("[data-entry-id='source-message']")).toBeNull();
    const preview = threadContainer.querySelector<HTMLButtonElement>(
      ".chat-reply-preview--message",
    );
    expect(preview).not.toBeNull();
    preview!.click();

    expect(open).toHaveBeenCalledWith("source-message");
    expect(searchContainer.querySelector("input")).toBeNull();
    transcript.hostDisconnected();
  });
});
