/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { getTranscriptState } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  transcriptDomState,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

function message(id: string, role: string, content: unknown, seq: number, runId?: string) {
  return {
    role,
    content,
    timestamp: seq * 1_000,
    __openclaw: { id, seq, ...(runId ? { runId } : {}) },
  };
}

describe("conversation position rail", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("publishes consecutive reader offsets even when the virtual row range is unchanged", async () => {
    transcriptDomState.measuredRowHeight = 120;
    const requestUpdate = vi.fn();
    const transcript = new ChatTranscriptController({
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate,
      updateComplete: Promise.resolve(true),
    });
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: `row-${index}`,
      content: html`<div>${index}</div>`,
    }));
    const { container, session, renderRows } = await mountTestTranscript(
      "rail-notification",
      rows,
      transcript,
    );
    try {
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 4800 },
      });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      const ids = rows.map((row) => row.key);
      session.syncMessageRows(
        new Map(ids.map((id) => [id, id])),
        new Map(ids.map((id) => [id, id])),
      );
      renderRows(rows);
      const currentId = () => session.activeMessageId(["row-2", "row-3"]);
      container.scrollTop = 50;
      container.dispatchEvent(new Event("scroll"));
      expect(currentId()).toBe("row-2");
      requestUpdate.mockClear();

      // Both viewports span rows 0–5, but their midpoints straddle row 3.
      // TanStack's range/isScrolling notification alone cannot publish this.
      container.scrollTop = 70;
      container.dispatchEvent(new Event("scroll"));
      expect(requestUpdate).toHaveBeenCalled();
      expect(currentId()).toBe("row-3");
      requestUpdate.mockClear();
      container.scrollTop = 50;
      container.dispatchEvent(new Event("scroll"));
      expect(requestUpdate).toHaveBeenCalled();
      expect(currentId()).toBe("row-2");

      Object.defineProperty(container, "clientHeight", { configurable: true, value: 640 });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 640);
      }
      expect(currentId()).toBe("row-3");
      requestUpdate.mockClear();
      container.dispatchEvent(new Event("scroll"));
      expect(requestUpdate).not.toHaveBeenCalled();

      transcript.hostDisconnected();
      requestUpdate.mockClear();
      container.scrollTop = 70;
      container.dispatchEvent(new Event("scroll"));
      expect(requestUpdate).not.toHaveBeenCalled();
    } finally {
      transcript.hostDisconnected();
    }
  });

  it("resolves distant reader positions before scroll notification and counts the header once", async () => {
    transcriptDomState.measuredRowHeight = 120;
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: `row-${index}`,
      content: html`<div>${index}</div>`,
    }));
    const { container, transcript, session, renderRows } = await mountTestTranscript(
      "rail-offset",
      rows,
    );
    try {
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 4880 },
      });
      container.style.paddingTop = "80px";
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      const ids = rows.map((row) => row.key);
      session.syncMessageRows(
        new Map(ids.map((id) => [id, id])),
        new Map(ids.map((id) => [id, id])),
      );
      renderRows(rows);
      // No scroll event or render between these queries: mounted rows are stale.
      container.scrollTop = 100;
      expect(session.activeMessageId(ids)).toBe("row-2");
      container.scrollTop = 3000;
      expect(session.activeMessageId(ids)).toBe("row-26");
      Object.defineProperty(container, "clientHeight", { configurable: true, value: 300 });
      expect(session.activeMessageId(ids)).toBe("row-25");
      container.scrollTop = 4580;
      expect(session.activeMessageId(ids)).toBe("row-39");
      expect(session.activeMessageId(["missing"])).toBeNull();
    } finally {
      transcript.hostDisconnected();
    }
  });

  it("keeps focused previews after pointer exit and resets interaction when the session changes", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(
        `message-${index}`,
        index % 2 ? "assistant" : "user",
        `Checkpoint ${index}`,
        index + 1,
      ),
    );
    const props = threadProps("rail-interaction", "agent:main:first", messages);
    const historyIntent = vi.fn();
    props.onHistoryIntent = historyIntent;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    props.onRequestUpdate = rerender;
    const markers = () => [
      ...container.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker"),
    ];
    const preview = () => container.querySelector(".chat-position-rail__preview-copy")?.textContent;
    try {
      rerender();
      transcript.hostConnected();
      expect(markers()).toHaveLength(40);
      // Rail wheel input belongs to its scrollport, never transcript history.
      for (const type of ["wheel", "touchstart", "touchmove"]) {
        container
          .querySelector(".chat-position-rail__marks")!
          .dispatchEvent(new Event(type, { bubbles: true }));
      }
      for (const key of ["PageUp", "PageDown"]) {
        expect(
          markers()[0]!.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          ),
        ).toBe(true);
      }
      expect(historyIntent).not.toHaveBeenCalled();
      container
        .querySelector(".chat-thread")!
        .dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      expect(historyIntent).toHaveBeenCalledOnce();
      container
        .querySelector(".chat-thread")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
      expect(historyIntent).toHaveBeenCalledTimes(2);
      expect(preview()).toBeUndefined();
      markers()[4]!.focus();
      expect(preview()).toContain("Checkpoint 4");
      markers()[2]!.dispatchEvent(new Event("pointerenter"));
      expect(preview()).toContain("Checkpoint 2");
      container.querySelector(".chat-position-rail")!.dispatchEvent(new Event("pointerleave"));
      expect(preview()).toContain("Checkpoint 4");
      markers()[4]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(markers()[5]);
      expect(preview()).toContain("Checkpoint 5");
      const focused = document.activeElement;
      props.messages = [
        ...messages,
        message("message-40", "user", "Checkpoint 40", 41),
        message("message-41", "assistant", "Checkpoint 41", 42),
      ];
      rerender();
      expect(markers()).toHaveLength(42);
      expect(document.activeElement).toBe(focused);
      expect(preview()).toContain("Checkpoint 5");
      focused!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(preview()).toBeUndefined();
      markers()[0]!.focus();
      expect(preview()).toBeDefined();
      render(nothing, container);
      const escapeAfterRemoval = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(escapeAfterRemoval);
      expect(escapeAfterRemoval.defaultPrevented).toBe(false);
      rerender();
      expect(preview()).toBeUndefined();
      props.sessionKey = "agent:main:second";
      rerender();
      expect(preview()).toBeUndefined();
      const state = getTranscriptState(props.paneId);
      state.searchOpen = true;
      state.searchQuery = "Checkpoint 5";
      rerender();
      expect(markers()).toHaveLength(1);
      state.searchQuery = "not present";
      rerender();
      expect(markers()).toHaveLength(0);
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each([
    { role: "user", senderName: undefined, label: "User message" },
    { role: "user", senderName: "Alice Example", label: "Alice Example" },
    { role: "assistant", senderName: "Alice Example", label: "Assistant message" },
  ])(
    "renders safe Markdown and attribution in $role previews ($label)",
    ({ role, senderName, label }) => {
      const messages = [
        message(
          "formatted",
          role,
          "**Important** *detail* `code`\n\n- [Guide](https://example.com)\n<script>alert(1)</script>",
          1,
        ),
        message("next", role === "user" ? "assistant" : "user", "Next turn", 2),
      ];
      Object.assign(messages[0]!["__openclaw"], { senderName });
      const props = threadProps("rail-markdown", "agent:main:markdown", messages);
      props.userName = "Local Viewer";
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = () => {
        render(renderChatThread(props, transcript), container);
        transcript.hostUpdated();
      };
      props.onRequestUpdate = rerender;
      try {
        rerender();
        transcript.hostConnected();
        container.querySelector<HTMLButtonElement>(".chat-position-rail__marker")!.focus();
        const preview = container.querySelector(".chat-position-rail__preview-copy")!;
        expect(container.querySelector(".chat-position-rail__preview-label")?.textContent).toBe(
          label,
        );
        const avatar = container.querySelector(".chat-position-rail__preview .chat-author-avatar");
        expect(avatar?.getAttribute("aria-label") ?? null).toBe(
          role === "user" ? (senderName ?? null) : null,
        );
        expect(preview.querySelector("strong")?.textContent).toBe("Important");
        expect(preview.querySelector("em")?.textContent).toBe("detail");
        expect(preview.querySelector("code")?.textContent).toBe("code");
        expect(preview.querySelector("li a")?.textContent).toBe("Guide");
        expect(preview.querySelector("script")).toBeNull();
        expect(preview.closest("[inert]")).not.toBeNull();
      } finally {
        render(nothing, container);
        transcript.hostDisconnected();
      }
    },
  );

  it("indexes three assistant messages as one run when history starts mid-run", () => {
    // A paginated history window can omit the user boundary of an existing run.
    const messages = [
      message("first", "assistant", "Checking the existing style", 1, "run-partial"),
      message(
        "call-1",
        "assistant",
        [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
        2,
        "run-partial",
      ),
      {
        ...message("result-1", "toolResult", "Styles loaded", 3, "run-partial"),
        toolCallId: "read-1",
        toolName: "read",
      },
      message("second", "assistant", "Rendering the launch card", 4, "run-partial"),
      message(
        "call-2",
        "assistant",
        [{ type: "toolCall", id: "render-1", name: "exec", arguments: {} }],
        5,
        "run-partial",
      ),
      {
        ...message("result-2", "toolResult", "Asset rendered", 6, "run-partial"),
        toolCallId: "render-1",
        toolName: "exec",
      },
      message("final", "assistant", "The launch card is ready", 7, "run-partial"),
      message("thinking", "assistant", "<thinking>Private planning</thinking>", 8, "run-partial"),
    ];
    const props = {
      ...threadProps("rail-partial-run", "agent:main:main", messages),
      showToolCalls: true,
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    props.onRequestUpdate = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    try {
      props.onRequestUpdate();
      transcript.hostConnected();
      const markers = container.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker");
      expect(markers).toHaveLength(1);
      markers[0]!.focus();
      expect(container.querySelector(".chat-position-rail__preview-copy")?.textContent).toContain(
        "The launch card is ready",
      );
      expect(
        container.querySelector(".chat-position-rail__preview-copy")?.textContent,
      ).not.toContain("Styles loaded");
    } finally {
      render(nothing, container);
      transcript.hostDisconnected();
    }
  });

  it("keeps the focused run marker through streaming and retargets its persisted answer", async () => {
    const user = message("question", "user", "Review the card", 1, "stream-run");
    const props = threadProps("rail-stream-handoff", "agent:main:main", [user]);
    Object.assign(props, {
      runId: "stream-run",
      runActive: true,
      runWorking: true,
      stream: "<thinking>Private planning</thinking>",
      streamStartedAt: 2_000,
    });
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    props.onRequestUpdate = rerender;
    const marker = () =>
      container.querySelector<HTMLButtonElement>('[data-position-marker-id="run:stream-run"]')!;
    try {
      rerender();
      transcript.hostConnected();
      expect(container.querySelectorAll(".chat-position-rail__marker")).toHaveLength(1);
      props.stream = "Draft response";
      rerender();
      const provisional = marker();
      provisional.focus();
      expect(container.querySelector(".chat-position-rail__preview-copy")?.textContent).toContain(
        "Draft response",
      );
      const streamBubble = [...container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
        (bubble) => bubble.textContent?.includes("Draft response"),
      )!;
      provisional.click();
      await Promise.resolve();
      expect(streamBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
      props.messages = [
        user,
        message("persisted-answer", "assistant", "Final response", 3, "stream-run"),
      ];
      Object.assign(props, { stream: null, runActive: false, runWorking: false, runId: null });
      rerender();
      expect(marker()).toBe(provisional);
      expect(document.activeElement).toBe(provisional);
      expect(container.querySelector(".chat-position-rail__preview-copy")?.textContent).toContain(
        "Final response",
      );
      const persistedBubble = container.querySelector<HTMLElement>(
        '[data-entry-id="persisted-answer"]',
      )!;
      marker().click();
      await Promise.resolve();
      expect(persistedBubble.classList.contains("chat-bubble--reply-target")).toBe(true);
      expect(container.querySelectorAll(".chat-position-rail__marker")).toHaveLength(2);
    } finally {
      render(nothing, container);
      transcript.hostDisconnected();
    }
  });
});
