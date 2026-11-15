import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { resizeObservers, type TestContentRow } from "./chat-transcript.test-support.ts";

export const transcriptContainer = () => document.body.appendChild(document.createElement("div"));

export function contentRows(count: number, prefix = "row:", label = "row"): TestContentRow[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "content",
    key: `${prefix}${index}`,
    content: (
      <div>
        {label} {index}
      </div>
    ),
  }));
}

export function emitTranscriptResize(target: Element, width: number, height: number) {
  for (const observer of resizeObservers) {
    observer.emitTarget(target, width, height);
  }
}

export function setTranscriptViewport(container: HTMLElement, height: number | (() => number)) {
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: {
      configurable: true,
      ...(typeof height === "function" ? { get: height } : { value: height }),
    },
  });
}

export function threadFixture(props: ChatThreadProps) {
  const transcript = createTestTranscript();
  const container = transcriptContainer();
  const rerender = () => render(renderChatThread(props, transcript), container);
  return { transcript, container, rerender };
}
