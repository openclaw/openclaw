/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { getChatAttachmentDataUrl } from "../attachment-payload-store.ts";
import { createComposerProps, resetComposerFixture } from "../chat-composer.test-support.ts";
import { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";
import { setFileDraft } from "./chat-file-drafts.ts";
import {
  createFileSessionAttachment,
  type FileSessionAttachment,
} from "./chat-file-session-attachment.ts";
import type {
  SidebarSelection,
  FileSidebarContent,
  FileReaderDownload,
} from "./chat-sidebar-content-types.ts";

afterEach(async () => {
  await resetComposerFixture();
  vi.unstubAllGlobals();
});

it.each(["file", "session", "connection", "unmount"] as const)(
  "drops a pending download after %s changes and balances pending reads",
  async (change) => {
    const result = createDeferredCore<FileReaderDownload | null>();
    let signal: AbortSignal | undefined;
    let calls = 0;
    let pending = 0;
    const attachments: ChatAttachment[] = [];
    const file: SidebarSelection = {
      kind: "file",
      path: "notes.md",
      name: "notes.md",
      content: "Preview only",
      download: (value) => {
        signal = value;
        calls++;
        return result.promise;
      },
    };
    const [content, setContent] = createSignal(file);
    const [session, setSession] = createSignal("agent:main:first");
    const [epoch, setEpoch] = createSignal(1);
    const chat = createComposerProps({
      getAttachments: () => attachments,
      onAttachmentsChange: (values) => {
        attachments.splice(0, attachments.length, ...values);
      },
      onPendingReadsChange: (delta) => {
        pending += delta;
      },
    });
    let action!: () => FileSessionAttachment | undefined;
    const view = mountSolid(() => {
      action = createFileSessionAttachment({
        get attachmentChat() {
          return { ...chat, sessionKey: session() };
        },
        get content() {
          return content();
        },
        get attachmentRuntime() {
          return { connectionEpoch: epoch() };
        },
      });
      return (
        <button disabled={action()?.disabled} onClick={() => action()?.attach()}>
          Attach
        </button>
      );
    });
    action()?.attach();
    action()?.attach();
    flush();
    await waitForSolid(() => expect(calls).toBe(1));
    expect(pending).toBe(1);
    if (change === "file") {
      setContent({ ...file, path: "other.md" });
    } else if (change === "session") {
      setSession("agent:main:second");
    } else if (change === "connection") {
      setEpoch(2);
    } else {
      view.unmount();
    }
    flush();
    expect(signal?.aborted).toBe(true);
    expect(pending).toBe(0);
    result.resolve({ filename: "notes.md", blob: new Blob(["wrong session"]) });
    await result.promise;
    await Promise.resolve();
    flush();
    expect(attachments).toEqual([]);
    expect(pending).toBe(0);
  },
);

it.each(["original", "dirty", "fallback"])(
  "stages file bytes through the attachment owner (%s)",
  async (kind) => {
    const dirty = kind === "dirty";
    const downloadUrl = "/api/artifacts/download/fixture/notes";
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("Original\r\nbytes", { headers: { "content-type": "text/markdown" } }),
    );
    if (kind === "fallback") {
      vi.stubGlobal("fetch", fetcher);
    }
    let attachments: ChatAttachment[] = [];
    let pending = 0;
    let sends = 0;
    const reads = new ChatAttachmentReadLifecycle(() => {});
    const chat = createComposerProps({
      draft: "Review this file",
      getDraft: () => "Review this file",
      getAttachments: () => attachments,
      onAttachmentsChange: (values) => {
        attachments = values;
      },
      attachmentReads: reads,
      readSignal: reads.readSignal,
      onPendingReadsChange: (delta) => {
        pending += delta;
      },
      onSend: () => {
        sends++;
      },
    });
    const file: FileSidebarContent = {
      kind: "file",
      name: "notes.md",
      path: "notes.md",
      draftKey: "attach-test",
      content: "Truncated preview",
      mimeType: "text/markdown",
      download: async () => ({
        filename: "notes.md",
        blob: new Blob(["Original\r\nbytes"], { type: "text/markdown" }),
      }),
    };
    if (dirty) {
      setFileDraft(file, { content: "Visible edits", expectedHash: "fixture" });
    }
    const view = mountSolid(() => {
      const action = createFileSessionAttachment({
        attachmentChat: chat,
        attachmentRuntime: {},
        content:
          kind === "fallback"
            ? {
                kind: "markdown",
                content: "Not previewable",
                fileDownload: {
                  path: file.path,
                  name: file.name,
                  download: async () => ({ url: downloadUrl, filename: file.name }),
                },
              }
            : file,
      });
      return <button onClick={() => action()?.attach()}>Attach</button>;
    });
    view.container.querySelector("button")!.click();
    await waitForSolid(() => expect(attachments).toHaveLength(1));
    const attachment = attachments[0];
    if (!attachment) {
      throw new Error("The file was not staged");
    }
    expect(attachment).toMatchObject({
      fileName: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: dirty ? 13 : 15,
    });
    expect(getChatAttachmentDataUrl(attachment)).toBe(
      dirty
        ? "data:text/markdown;base64,VmlzaWJsZSBlZGl0cw=="
        : "data:text/markdown;base64,T3JpZ2luYWwNCmJ5dGVz",
    );
    if (kind === "fallback") {
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[0]).toBe(downloadUrl);
    }
    expect(chat.getDraft?.()).toBe("Review this file");
    expect(pending).toBe(0);
    expect(sends).toBe(0);
    setFileDraft(file, null);
  },
);
