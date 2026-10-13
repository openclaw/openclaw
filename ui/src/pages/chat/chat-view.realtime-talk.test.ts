// @vitest-environment jsdom

import { render } from "lit";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import type { renderChat } from "./chat-view.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);

function renderChatView(overrides: Partial<Parameters<typeof renderChat>[0]>) {
  const container = createComposerContainer();
  const props = createChatProps(overrides);
  onTestFinished(async () => {
    await vi.dynamicImportSettled();
    props.transcript.hostDisconnected();
    render(null, container);
    resetChatViewState();
    resetTranscriptTestDom();
  });
  renderChatPropsInto(container, props);
  return container;
}

function voiceTurnTexts(container: ParentNode): string[] {
  return [...container.querySelectorAll(".agent-chat__voice-turn-text")].map(
    (turn) => turn.textContent ?? "",
  );
}

const savedLights = {
  role: "user" as const,
  content: "Turn off the lights",
  timestamp: 1,
  __openclaw: { id: "voice:call:1" },
};
const savedChecking = {
  role: "assistant" as const,
  content: "Checking",
  timestamp: 2,
  __openclaw: { id: "voice:call:2" },
};
const typedAfter = {
  role: "user" as const,
  content: "typed after the call",
  timestamp: 3,
  __openclaw: { id: "typed:1" },
};

describe("realtime Talk tail block gating", () => {
  it("hides the realtime Talk tail while idle once saved captions are in history", () => {
    const container = renderChatView({
      realtimeTalkActive: false,
      messages: [savedLights, savedChecking, typedAfter],
      realtimeTalkConversation: [
        {
          id: "u1",
          role: "user",
          text: "Turn off the lights",
          isStreaming: false,
          transcriptId: "voice:call:1",
        },
        {
          id: "a1",
          role: "assistant",
          text: "Checking",
          isStreaming: false,
          transcriptId: "voice:call:2",
        },
      ],
    });

    expect(container.querySelector(".agent-chat__voice-turns")).toBeNull();
    expect(container.querySelector(".agent-chat__voice-turn")).toBeNull();
    const text = container.textContent ?? "";
    const voiceIndex = text.indexOf("Turn off the lights");
    const typedIndex = text.indexOf("typed after the call");
    expect(voiceIndex).toBeGreaterThanOrEqual(0);
    expect(typedIndex).toBeGreaterThan(voiceIndex);
  });

  it("keeps an unmatched voice caption visible after Talk becomes idle", () => {
    const container = renderChatView({
      realtimeTalkActive: false,
      messages: [typedAfter],
      realtimeTalkConversation: [
        {
          id: "u2",
          role: "user",
          text: "Still only in the live caption",
          isStreaming: false,
          transcriptId: "voice:call:unmatched",
        },
      ],
    });

    expect(container.querySelector(".agent-chat__voice-turns")).not.toBeNull();
    expect(voiceTurnTexts(container)).toEqual(["Still only in the live caption"]);
    expect(container.textContent).toContain("typed after the call");
  });

  it("hides saved idle captions from the tail while an unmatched caption stays visible", () => {
    const container = renderChatView({
      realtimeTalkActive: false,
      messages: [savedLights, savedChecking, typedAfter],
      realtimeTalkConversation: [
        {
          id: "u1",
          role: "user",
          text: "Turn off the lights",
          isStreaming: false,
          transcriptId: "voice:call:1",
        },
        {
          id: "a1",
          role: "assistant",
          text: "Checking",
          isStreaming: false,
          transcriptId: "voice:call:2",
        },
        {
          id: "u2",
          role: "user",
          text: "Still only in the live caption",
          isStreaming: false,
          transcriptId: "voice:call:unmatched",
        },
      ],
    });

    expect(voiceTurnTexts(container)).toEqual(["Still only in the live caption"]);
    const text = container.textContent ?? "";
    expect(text.indexOf("Turn off the lights")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("typed after the call")).toBeGreaterThan(
      text.indexOf("Turn off the lights"),
    );
    expect(text.indexOf("Still only in the live caption")).toBeGreaterThan(
      text.indexOf("typed after the call"),
    );
  });

  it("retires an unmatched idle caption only when its saved history row arrives", () => {
    const container = createComposerContainer();
    const transcript = createChatProps().transcript;
    onTestFinished(async () => {
      await vi.dynamicImportSettled();
      transcript.hostDisconnected();
      render(null, container);
      resetChatViewState();
      resetTranscriptTestDom();
    });
    const conversation = [
      {
        id: "u1",
        role: "user" as const,
        text: "Unmatched until save",
        isStreaming: false,
        transcriptId: "voice:call:1",
      },
    ];
    renderChatPropsInto(
      container,
      createChatProps({
        transcript,
        realtimeTalkActive: false,
        messages: [],
        realtimeTalkConversation: conversation,
      }),
    );

    expect(voiceTurnTexts(container)).toEqual(["Unmatched until save"]);

    renderChatPropsInto(
      container,
      createChatProps({
        transcript,
        realtimeTalkActive: false,
        messages: [
          {
            role: "user",
            content: "Unmatched until save",
            timestamp: 1,
            __openclaw: { id: "voice:call:1" },
          },
        ],
        realtimeTalkConversation: conversation,
      }),
    );

    expect(container.querySelector(".agent-chat__voice-turns")).toBeNull();
    expect(container.textContent).toContain("Unmatched until save");
  });
});
