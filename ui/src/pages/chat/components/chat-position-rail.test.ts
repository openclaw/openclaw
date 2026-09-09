/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { getTranscriptState } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
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
    const { container, session } = await mountTestTranscript("rail-notification", rows, transcript);
    try {
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 4800 },
      });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      const ids = rows.map((row) => row.key);
      session.syncMessageRows(new Map(ids.map((id) => [id, id])));
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
    const { container, transcript, session } = await mountTestTranscript("rail-offset", rows);
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
      session.syncMessageRows(new Map(ids.map((id) => [id, id])));
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
      expect(markers()).toHaveLength(0);
      state.searchQuery = "not present";
      rerender();
      expect(markers()).toHaveLength(0);
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each(["user", "assistant"])("renders safe Markdown in %s previews", (role) => {
    const messages = [
      message(
        "formatted",
        role,
        "**Important** *detail* `code`\n\n- [Guide](https://example.com)\n<script>alert(1)</script>",
        1,
      ),
      message("next", role === "user" ? "assistant" : "user", "Next turn", 2),
    ];
    const props = threadProps("rail-markdown", "agent:main:markdown", messages);
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
      expect(preview.querySelector("strong")?.textContent).toBe("Important");
      expect(preview.querySelector("em")?.textContent).toBe("detail");
      expect(preview.querySelector("code")?.textContent).toBe("code");
      expect(preview.querySelector("li a")?.textContent).toBe("Guide");
      expect(preview.querySelector("script")).toBeNull();
      expect(preview.closest("[inert]")).not.toBeNull();
    } finally {
      transcript.hostDisconnected();
    }
  });

  it("uses the visible completed answer and keeps attachment-only user landmarks", () => {
    const messages = [
      message("question", "user", "Inspect the design", 1),
      message("commentary", "assistant", "Checking the files", 2, "run-1"),
      {
        ...message("tool", "toolResult", "File contents", 3, "run-1"),
        toolName: "read",
        toolCallId: "read-1",
      },
      message("answer", "assistant", "The design is ready", 4, "run-1"),
      message(
        "attachment",
        "user",
        [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }],
        5,
      ),
    ];
    const props = threadProps("rail-projection", "agent:main:projection", messages);
    const transcript = createTestTranscript();
    let landmarks: readonly unknown[] = [];
    transcript.renderSession(props.paneId, props.sessionKey, (session) => {
      landmarks = projectChatTranscript(props, session).positionMessages;
      return html``;
    });
    expect(landmarks).toEqual([messages[0], messages[3], messages[4]]);
    transcript.hostDisconnected();
  });

  it("does not target a final-answer action owner folded behind dashboard work", () => {
    const messages = [
      message("question", "user", "Inspect the design", 1),
      { ...message("final", "assistant", "Design ready", 2, "run-1"), phase: "final_answer" },
      {
        ...message("tool-1", "toolResult", "File contents", 3, "run-1"),
        toolName: "read",
        toolCallId: "read-1",
      },
      {
        ...message("tail", "assistant", "Checking the saved result", 4, "run-1"),
        phase: "commentary",
      },
      {
        ...message("tool-2", "toolResult", "Saved", 5, "run-1"),
        toolName: "read",
        toolCallId: "read-2",
      },
    ];
    const props = {
      ...threadProps("rail-folded", "agent:main:dashboard:audit", messages),
      showToolCalls: true,
      persistCommentary: true,
      runWorking: false,
    };
    const transcript = createTestTranscript();
    let landmarks: readonly unknown[] = [];
    transcript.renderSession(props.paneId, props.sessionKey, (session) => {
      landmarks = projectChatTranscript(props, session).positionMessages;
      return html``;
    });
    expect(landmarks).toEqual([messages[0], messages[3]]);
    transcript.hostDisconnected();
  });
});
