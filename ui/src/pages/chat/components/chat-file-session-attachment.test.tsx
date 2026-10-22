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
import { createFileSessionAttachment } from "./chat-file-session-attachment.ts";
import type {
  AttachmentSidebarRuntime,
  SidebarSelection,
  FileSidebarContent,
  FileReaderDownload,
} from "./chat-sidebar-content-types.ts";

afterEach(async () => {
  await resetComposerFixture();
  vi.unstubAllGlobals();
});

it.each(["file", "session", "connection", "unmount"] as const)(
  "retires a pending download before %s publication and balances pending reads",
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
    let action!: ReturnType<typeof createFileSessionAttachment>;
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
    const next = {
      content: change === "file" ? { ...file, path: "other.md" } : file,
      attachmentChat: {
        ...chat,
        sessionKey: change === "session" ? "agent:main:second" : "agent:main:first",
      },
      attachmentRuntime: { connectionEpoch: change === "connection" ? 2 : 1 },
    };
    if (change !== "unmount") {
      action.retire(next);
    }
    if (change === "file") {
      setContent(next.content);
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

it.each([
  "source",
  "destination",
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
] as const)("retires a held transfer before native %s publication", async (change) => {
  const completion = createDeferredCore<FileReaderDownload | null>();
  const attachments: ChatAttachment[] = [];
  let balance = 0;
  let signal: AbortSignal | undefined;
  const file: FileSidebarContent = {
    kind: "file",
    path: "notes.md",
    name: "notes.md",
    content: "Preview",
    download: (nextSignal) => {
      signal = nextSignal;
      return completion.promise;
    },
  };
  const runtime: AttachmentSidebarRuntime = {
    policyKey: "first",
    authToken: "synthetic-first",
    agentId: "main",
    sessionKey: "agent:main:first",
    resourceBasePath: "/",
  };
  const props = {
    content: file,
    attachmentRuntime: runtime,
    attachmentChat: createComposerProps({
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
  let transfer!: ReturnType<typeof createFileSessionAttachment>;
  const view = mountSolid(() => {
    transfer = createFileSessionAttachment(props);
    return (
      <button disabled={transfer()?.disabled} onClick={() => transfer()?.attach()}>
        Attach
      </button>
    );
  });
  view.getByRole("button", { name: "Attach" }).click();
  expect(balance).toBe(1);
  await waitForSolid(() => expect(transfer()?.pending).toBe(true));
  const next = { ...props };
  if (change === "source") {
    next.content = { ...file, download: async () => null };
  } else if (change === "destination") {
    next.attachmentChat = { ...props.attachmentChat, sessionKey: "agent:main:other" };
  } else if (change === "policy") {
    next.attachmentRuntime = { ...props.attachmentRuntime, policyKey: "next" };
  } else if (change === "auth") {
    next.attachmentRuntime = { ...props.attachmentRuntime, authToken: "synthetic-next" };
  } else if (change === "runtime agent") {
    next.attachmentRuntime = { ...props.attachmentRuntime, agentId: "other" };
  } else if (change === "runtime session") {
    next.attachmentRuntime = { ...props.attachmentRuntime, sessionKey: "agent:main:other" };
  } else if (change === "resource base") {
    next.attachmentRuntime = { ...props.attachmentRuntime, resourceBasePath: "/next/" };
  } else if (change === "artifact resolver") {
    next.attachmentRuntime = {
      ...props.attachmentRuntime,
      resolveArtifactDownload: async () => null,
    };
  } else if (change === "hidden") {
    next.filePresented = false;
  } else if (change === "folder") {
    next.fileWorkspace = { showingFolder: true };
  } else if (change === "pending owner") {
    next.attachmentChat = { ...props.attachmentChat, onPendingReadsChange: () => {} };
  }
  transfer.retire(change === "disconnect" ? undefined : next);
  expect(signal?.aborted).toBe(true);
  expect(balance).toBe(0);
  await waitForSolid(() => expect(transfer()?.pending).toBe(false));
  completion.resolve({ filename: "notes.md", blob: new Blob(["Retired bytes"]) });
  await completion.promise;
  await Promise.resolve();
  flush();
  expect(attachments).toEqual([]);
  expect(balance).toBe(0);
  view.unmount();
});
