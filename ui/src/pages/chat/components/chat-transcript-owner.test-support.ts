import type { SolidControllerHost } from "../../../lib/reactive/solid-controller-host.ts";
import { createChatTranscript, type ChatTranscript } from "./chat-transcript-controller.ts";
import type { TranscriptCallbacks } from "./chat-transcript-session.ts";

/** Keep existing DOM fixtures' lifecycle vocabulary outside the production owner. */
export function createTranscriptTestOwner(
  host: SolidControllerHost,
  paneId: () => string,
  callbacks?: TranscriptCallbacks,
) {
  const owner = withTranscriptTestLifecycle(
    createChatTranscript(() => host.requestUpdate(), paneId, callbacks),
  );
  host.addController(owner);
  return owner;
}

export function withTranscriptTestLifecycle(owner: ChatTranscript) {
  return Object.assign(owner, {
    hostConnected: owner.start,
    hostUpdated: owner.update,
    hostDisconnected: owner.dispose,
  });
}

export type TestChatTranscript = ReturnType<typeof createTranscriptTestOwner>;
