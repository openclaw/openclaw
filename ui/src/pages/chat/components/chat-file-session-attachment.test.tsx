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
  type FileSessionAttachmentProps,
} from "./chat-file-session-attachment.ts";
import type { FileSidebarContent, FileReaderDownload } from "./chat-sidebar-content-types.ts";

afterEach(async () => {
  await resetComposerFixture();
  vi.unstubAllGlobals();
});

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
    const attachment = attachments[0]!;
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

it.each([
  "file",
  "session",
  "connection",
  "unmount",
  "source",
  "policy",
  "auth",
  "runtime agent",
  "runtime session",
  "resource base",
  "artifact resolver",
  "hidden",
  "folder",
  "pending owner",
  "disconnect",
] as const)(
  "retires a held transfer before %s publication and balances pending reads",
  async (change) => {
    const completion = createDeferredCore<FileReaderDownload | null>();
    const attachments: ChatAttachment[] = [];
    let balance = 0;
    let signal: AbortSignal | undefined;
    const download = vi.fn((nextSignal: AbortSignal) => {
      signal = nextSignal;
      return completion.promise;
    });
    const file: FileSidebarContent = {
      kind: "file",
      path: "notes.md",
      name: "notes.md",
      content: "Preview",
      download,
    };
    const initial: FileSessionAttachmentProps = {
      content: file,
      attachmentRuntime: {
        connectionEpoch: 1,
        policyKey: "first",
        authToken: "synthetic-first",
        agentId: "main",
        sessionKey: "agent:main:first",
        resourceBasePath: "/",
      },
      attachmentChat: createComposerProps({
        sessionKey: "agent:main:first",
        getAttachments: () => attachments,
        onAttachmentsChange: (next) => {
          attachments.splice(0, attachments.length, ...next);
        },
        onPendingReadsChange: (delta) => {
          balance += delta;
        },
      }),
      filePresented: true,
      fileWorkspace: { showingFolder: false },
    };
    const [props, setProps] = createSignal(initial);
    let transfer!: ReturnType<typeof createFileSessionAttachment>;
    function TransferButton(current: FileSessionAttachmentProps) {
      transfer = createFileSessionAttachment(current);
      return <button onClick={() => transfer()?.attach()}>Attach</button>;
    }
    const view = mountSolid(() => <TransferButton {...props()} />);
    const button = view.getByRole("button", { name: "Attach" });
    button.click();
    button.click();
    expect(balance).toBe(1);
    await waitForSolid(() => expect(transfer()?.pending).toBe(true));
    expect(download).toHaveBeenCalledOnce();
    const runtime = (patch: Partial<FileSessionAttachmentProps["attachmentRuntime"]>) => ({
      attachmentRuntime: { ...initial.attachmentRuntime, ...patch },
    });
    const changes: Record<typeof change, Partial<FileSessionAttachmentProps>> = {
      file: { content: { ...file, path: "other.md" } },
      source: { content: { ...file, download: async () => null } },
      session: { attachmentChat: { ...initial.attachmentChat!, sessionKey: "agent:main:other" } },
      connection: runtime({ connectionEpoch: 2 }),
      policy: runtime({ policyKey: "next" }),
      auth: runtime({ authToken: "synthetic-next" }),
      "runtime agent": runtime({ agentId: "other" }),
      "runtime session": runtime({ sessionKey: "agent:main:other" }),
      "resource base": runtime({ resourceBasePath: "/next/" }),
      "artifact resolver": runtime({ resolveArtifactDownload: async () => null }),
      hidden: { filePresented: false },
      folder: { fileWorkspace: { showingFolder: true } },
      "pending owner": {
        attachmentChat: { ...initial.attachmentChat!, onPendingReadsChange: () => {} },
      },
      unmount: {},
      disconnect: {},
    };
    const next = { ...initial, ...changes[change] };
    if (change === "unmount") {
      view.unmount();
    } else {
      transfer.retire(change === "disconnect" ? undefined : next);
      if (change === "file" || change === "session" || change === "connection") {
        setProps(next);
        flush();
      }
    }
    expect(signal?.aborted).toBe(true);
    expect(balance).toBe(0);
    if (change !== "unmount") {
      await waitForSolid(() => expect(transfer()?.pending).toBe(false));
    }
    completion.resolve({ filename: "notes.md", blob: new Blob(["Retired bytes"]) });
    await completion.promise;
    await Promise.resolve();
    flush();
    expect(attachments).toEqual([]);
    expect(balance).toBe(0);
    view.unmount();
  },
);
