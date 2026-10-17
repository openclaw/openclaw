/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import { getTranscriptState, type ChatThreadProps } from "./chat-thread-interactions.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function voiceProjection(props: ChatThreadProps) {
  const controller = createTestTranscript(props.paneId);
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => {
    render(null, container);
    controller.dispose();
  });
  return () => {
    controller.renderSession(props.sessionKey, (session) => {
      const renderRows = vi.spyOn(session, "render");
      try {
        render(renderChatThread(props, controller), container);
        controller.start();
        controller.update();
        flush();
        expect(renderRows).toHaveBeenCalledOnce();
      } finally {
        renderRows.mockRestore();
      }
      return null;
    });
    return [...container.querySelectorAll(".agent-chat__voice-turn-text")].map(
      (turn) => turn.textContent,
    );
  };
}

describe("voice transcript membership", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each(["absent", "empty", "ID-less"] as const)(
    "skips the voice membership scan for %s captions",
    (kind) => {
      const messages = [
        { role: "user", content: "Saved message", __openclaw: { id: "voice:saved" } },
      ];
      const map = vi.spyOn(messages, "map");
      const props = threadProps(`voice-${kind}`, undefined, messages);
      props.realtimeTalkConversation =
        kind === "absent"
          ? undefined
          : kind === "empty"
            ? []
            : [{ id: "live", role: "user", text: "Still speaking", isStreaming: true }];

      expect(voiceProjection(props)()).toEqual(kind === "ID-less" ? ["Still speaking"] : []);
      expect(map.mock.calls.filter(([callback]) => callback === persistedMessageEntryId)).toEqual(
        [],
      );
    },
  );

  it("uses one raw-history scan, preserving pending captions and refreshing replaced history", () => {
    const messages = [
      { role: "user", content: "Hidden saved words", __openclaw: { id: "voice:saved" } },
      { role: "user", content: "Pending input", __openclaw: { id: "pending:input" } },
      {
        role: "user",
        content: "Pending send",
        __openclaw: { id: "send:pending", kind: "pending-send", state: "unconfirmed" },
      },
    ];
    const map = vi.spyOn(messages, "map");
    const props = threadProps("voice-membership", undefined, messages);
    props.realtimeTalkConversation = [
      {
        id: "saved",
        role: "user",
        text: "Saved caption",
        isStreaming: false,
        transcriptId: "voice:saved",
      },
      {
        id: "unsaved",
        role: "user",
        text: "Unsaved caption",
        isStreaming: false,
        transcriptId: "voice:unsaved",
      },
      { id: "live", role: "assistant", text: "Live caption", isStreaming: true },
      {
        id: "input",
        role: "user",
        text: "Pending input caption",
        isStreaming: false,
        transcriptId: "pending:input",
      },
      {
        id: "send",
        role: "user",
        text: "Pending send caption",
        isStreaming: false,
        transcriptId: "send:pending",
      },
    ];
    const state = getTranscriptState(props.paneId);
    state.search.toggle();
    state.search.setQuery("unmatched search");
    const project = voiceProjection(props);

    expect(project()).toEqual([
      "Unsaved caption",
      "Live caption",
      "Pending input caption",
      "Pending send caption",
    ]);
    expect(
      map.mock.calls.filter(([callback]) => callback === persistedMessageEntryId),
    ).toHaveLength(1);

    props.messages = [
      { role: "user", content: "New saved words", __openclaw: { id: "voice:unsaved" } },
      ...messages.slice(1),
    ];
    const replacementMap = vi.spyOn(props.messages, "map");
    expect(project()).toEqual([
      "Saved caption",
      "Live caption",
      "Pending input caption",
      "Pending send caption",
    ]);
    expect(
      replacementMap.mock.calls.filter(([callback]) => callback === persistedMessageEntryId),
    ).toHaveLength(1);
  });
});
