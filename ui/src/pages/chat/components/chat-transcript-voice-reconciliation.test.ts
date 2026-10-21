/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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

const savedMessage = (content: string, id: string, extra: object = {}) => ({
  role: "user",
  content,
  __openclaw: { id, ...extra },
});
const caption = (id: string, text: string, transcriptId: string) => ({
  id,
  role: "user" as const,
  text,
  isStreaming: false,
  transcriptId,
});
const membershipScans = (calls: readonly (readonly unknown[])[]) =>
  calls.filter(([callback]) => callback === persistedMessageEntryId);

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
      render(renderChatThread(props, controller), container);
      controller.start();
      controller.update();
      flush();
      expect(renderRows).toHaveBeenCalledOnce();
      renderRows.mockRestore();
      return null;
    });
    return [...container.querySelectorAll(".agent-chat__voice-turn-text")].map(
      (turn) => turn.textContent,
    );
  };
}

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each(["absent", "empty", "ID-less"] as const)(
  "skips the voice membership scan for %s captions",
  (kind) => {
    const messages = [savedMessage("Saved message", "voice:saved")];
    const map = vi.spyOn(messages, "map");
    const props = threadProps(`voice-${kind}`, undefined, messages);
    props.realtimeTalkConversation =
      kind === "absent"
        ? undefined
        : kind === "empty"
          ? []
          : [{ id: "live", role: "user", text: "Still speaking", isStreaming: true }];

    expect(voiceProjection(props)()).toEqual(kind === "ID-less" ? ["Still speaking"] : []);
    expect(membershipScans(map.mock.calls)).toEqual([]);
  },
);

it("uses one raw-history scan, preserving pending captions and refreshing replaced history", () => {
  const messages = [
    savedMessage("Hidden saved words", "voice:saved"),
    savedMessage("Pending input", "pending:input"),
    savedMessage("Pending send", "send:pending", { kind: "pending-send", state: "unconfirmed" }),
  ];
  const map = vi.spyOn(messages, "map");
  const props = threadProps("voice-membership", undefined, messages);
  props.realtimeTalkConversation = [
    caption("saved", "Saved caption", "voice:saved"),
    caption("unsaved", "Unsaved caption", "voice:unsaved"),
    { id: "live", role: "assistant", text: "Live caption", isStreaming: true },
    caption("input", "Pending input caption", "pending:input"),
    caption("send", "Pending send caption", "send:pending"),
  ];
  const state = getTranscriptState(props.paneId);
  state.search.toggle();
  state.search.setQuery("unmatched search");
  const project = voiceProjection(props);
  const pendingCaptions = ["Live caption", "Pending input caption", "Pending send caption"];

  expect(project()).toEqual(["Unsaved caption", ...pendingCaptions]);
  expect(membershipScans(map.mock.calls)).toHaveLength(1);

  props.messages = [savedMessage("New saved words", "voice:unsaved"), ...messages.slice(1)];
  const replacementMap = vi.spyOn(props.messages, "map");
  expect(project()).toEqual(["Saved caption", ...pendingCaptions]);
  expect(membershipScans(replacementMap.mock.calls)).toHaveLength(1);
});
