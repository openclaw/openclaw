/* @vitest-environment jsdom */

import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatSessionCompanionThread } from "../chat-session-companion.ts";
import { ComposerDictationOwner } from "../composer-dictation.ts";
import { DirectDictationControl } from "../composer-direct-dictation.ts";
import { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";
import { ChatSessionRail } from "./chat-session-rail.tsx";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  "unchanged",
  "compositionstart",
  "attachment-remove",
  "attachment-drop",
  "read-settlement",
])("retires held dictation Send for side chat input intent: %s", async (intent) => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
  );
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => {});
  const prepared = vi.spyOn(DirectDictationControl.prototype, "prepare");
  const reads = new ChatAttachmentReadLifecycle(() => {});
  const companion: ChatSessionCompanionThread = {
    draft: "A follow-up",
    turns: [],
    loading: false,
    // Removing a ready attachment also fences Send without a read lifecycle.
    attachmentReads: intent === "attachment-remove" ? undefined : reads,
    attachments:
      intent === "attachment-remove"
        ? [{ id: "notes", mimeType: "text/plain", fileName: "notes.txt" }]
        : [],
  };
  const changeAttachments = (attachments: ChatAttachment[]) => {
    companion.attachments = attachments;
  };
  const entry =
    intent === "read-settlement"
      ? reads.begin([new File(["notes"], "notes.txt")], [], {
          getAttachments: () => companion.attachments ?? [],
          onAttachmentsChange: changeAttachments,
        })[0]
      : undefined;
  const request = vi.fn(async (method: string) =>
    method === "talk.catalog" ? { transcription: { ready: true }, realtime: { ready: true } } : {},
  );
  const client = createTestGatewayClient(request);
  const submit = vi.fn();
  const view = mountSolid(() => (
    <ChatSessionRail
      sessionKey="agent:test:main"
      companion={companion}
      client={client}
      connected={true}
      presented={true}
      sendShortcut="enter"
      digest={null}
      running={false}
      activeRunId={null}
      pullRequests={[]}
      onSubmit={submit}
      onAttachmentsChange={changeAttachments}
    />
  ));
  try {
    await waitForSolid(() => expect(prepared).toHaveBeenCalled());
    const control = prepared.mock.contexts[0];
    assert.instanceOf(control, DirectDictationControl);
    const capture = control.dictation;
    assert.instanceOf(capture, ComposerDictationOwner);
    const finish = createDeferred<boolean>();
    const active = vi.spyOn(capture, "active", "get").mockReturnValue(true);
    vi.spyOn(capture, "finishActive").mockReturnValue(finish.promise);
    control.dispatchEvent(new Event("change"));
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-send-btn--dictation-commit")).not.toBeNull(),
    );
    const send = view.container.querySelector<HTMLButtonElement>(
      ".chat-send-btn--dictation-commit",
    );
    assert.instanceOf(send, HTMLButtonElement);
    send.click();
    active.mockReturnValue(false);
    control.dispatchEvent(new Event("change"));
    await waitForSolid(() => {
      const textarea = view.container.querySelector("textarea");
      assert.instanceOf(textarea, HTMLTextAreaElement);
      expect(textarea.readOnly).toBe(false);
    });
    if (intent === "compositionstart") {
      const textarea = view.container.querySelector("textarea");
      assert.instanceOf(textarea, HTMLTextAreaElement);
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    } else if (intent === "attachment-remove") {
      await waitForSolid(() =>
        expect(view.container.querySelector(".chat-attachment-remove")).not.toBeNull(),
      );
      const remove = view.container.querySelector<HTMLButtonElement>(".chat-attachment-remove");
      assert.instanceOf(remove, HTMLButtonElement);
      remove.click();
      expect(companion.attachments).toEqual([]);
    } else if (intent === "attachment-drop") {
      const rail = view.container.querySelector("section.chat-session-rail");
      assert.instanceOf(rail, HTMLElement);
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", {
        value: {
          files: [new File(["image"], "note.png", { type: "image/png" })],
          types: ["Files"],
          getData: () => "",
        },
      });
      const priorRevision = reads.revision;
      rail.dispatchEvent(drop);
      expect(reads.revision).toBeGreaterThan(priorRevision);
    } else if (intent === "read-settlement" && entry) {
      reads.complete(entry);
    }
    finish.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(intent === "unchanged" ? 1 : 0);
  } finally {
    reads.abortReads();
    view.unmount();
  }
});
