import { createComponent, createSignal, getOwner } from "solid-js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

export function mountChatThread(initial: ChatThreadProps, transcript: ChatTranscriptController) {
  const [current, setCurrent] = createSignal(initial, { equals: false, ownedWrite: true });
  const view = mountSolid(() =>
    createComponent(ChatThread, {
      get props() {
        return current();
      },
      transcript,
    }),
  );
  flush();
  return {
    ...view,
    update(props: ChatThreadProps) {
      setCurrent(() => props);
      if (!getOwner()) {
        flush();
      }
    },
  };
}
