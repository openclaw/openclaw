/* @vitest-environment jsdom */

import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, render, type LitElement } from "lit";
import "./components/chat-detail-panel.ts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult } from "../../api/types.ts";
import { loadSettings } from "../../app/settings.ts";
import {
  createReviewFixture,
  renderPanelFixture,
} from "../../test-helpers/chat-pane-embedded-panels.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import { resolveChatMessageAccess } from "./chat-message-access.ts";
import { availableSidebarSlots, sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import type { ChatProps } from "./chat-view.ts";
import { renderChatDetailSlot } from "./components/chat-detail-slot.ts";
import { renderAssistantAttachments } from "./components/chat-message-attachments.ts";
import {
  releaseChatMediaResourceSubscriber,
  type AttachmentItem,
} from "./components/chat-message-media.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
} from "./components/chat-session-workspace.ts";
import type { SidebarContent } from "./components/chat-sidebar-content-types.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";
import "./components/chat-sidebar-region.runtime.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  setSidebarExpanded,
  setSidebarOpen,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function discussionSlots(discussionAvailable: boolean) {
  const discussion = {} as SessionDiscussionPanelConfig;
  const definitions = sidebarPanelDefinitions({
    discussion,
    discussionAvailable,
  } as Parameters<typeof sidebarPanelDefinitions>[0]);
  return availableSidebarSlots(definitions);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("chat pane embedded panels", () => {
  it("navigates an existing file tab to an explicit line without resetting its editor or draft", async () => {
    const descriptors = ["getClientRects", "getBoundingClientRect"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(Range.prototype, key)] as const,
    );
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    onTestFinished(() => {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(Range.prototype, key, descriptor);
        } else {
          Reflect.deleteProperty(Range.prototype, key);
        }
      }
    });
    const { file, mount, renderPanels, state, sessions } = createReviewFixture();
    state.hello = gatewayHelloForMethods(["sessions.files.get", "sessions.files.set"]);
    const text = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    openSessionWorkspaceFile(state, { path: "navigation.txt", line: 2 });
    file.resolve({
      sessionKey: state.sessionKey,
      root: "/synthetic/workspace",
      file: {
        kind: "read",
        path: "navigation.txt",
        name: "navigation.txt",
        missing: false,
        content: text,
        hash: "original",
        previewKind: "text",
        contentEncoding: "utf8",
      },
    });
    await file.promise;
    await renderPanels();
    // Lit update completion does not include the editor's detached module load.
    await vi.dynamicImportSettled();
    const editorElement = await vi.waitFor(() =>
      expectDefined(mount.querySelector<HTMLElement>(".cm-editor"), "file editor"),
    );
    const editor = expectDefined(EditorView.findFromDOM(editorElement), "CodeMirror view");
    await vi.waitFor(() =>
      expect(mount.querySelector(".file-view__line--target")?.getAttribute("data-line")).toBe("2"),
    );
    const editButton = expectDefined(
      mount.querySelector<HTMLButtonElement>('[aria-label="Edit file"]'),
      "Edit action",
    );
    editButton.click();
    await renderPanels();
    editor.dispatch({ changes: { from: 0, to: 0, insert: "draft " } });
    const draft = editor.state.doc.toString();
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    onTestFinished(() => scroll.mockRestore());
    openSessionWorkspaceFile(state, { path: "navigation.txt", line: 7 });
    await renderPanels();
    await vi.waitFor(() =>
      expect(mount.querySelector(".file-view__line--target")?.getAttribute("data-line")).toBe("7"),
    );
    expect(mount.querySelector(".cm-editor")).toBe(editorElement);
    expect(editor.state.doc.toString()).toBe(draft);
    expect(scroll).toHaveBeenCalled();
    scroll.mockClear();
    openSessionWorkspaceFile(state, { path: "navigation.txt", line: 7 });
    await renderPanels();
    expect(scroll).toHaveBeenCalled();
    expect(editor.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(text);
    expect(sessions.getFile).toHaveBeenCalledOnce();
    expect(state.sessionWorkspaceState?.previews).toHaveLength(1);
    scroll.mockClear();
    editor.scrollDOM.scrollTop = 123;
    openSessionWorkspaceFile(state, { path: "navigation.txt" });
    await renderPanels();
    expect(mount.querySelector(".cm-editor")).toBe(editorElement);
    expect(editor.scrollDOM.scrollTop).toBe(123);
    expect(scroll).not.toHaveBeenCalled();
    sessions.setFile = vi.fn().mockResolvedValue({ file: { hash: "saved" } });
    editor.dispatch({ changes: { from: 0, to: 0, insert: "saved " } });
    await renderPanels();
    const save = expectDefined(
      [...mount.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Save",
      ),
      "Save action",
    );
    save.click();
    await vi.waitFor(() => expect(save.disabled).toBe(true));
    let savedText = editor.state.doc.toString();
    const saved = (await file.promise)!;
    const pendingRead = createDeferred<SessionWorkspaceGetResult | null>();
    vi.mocked(sessions.getFile).mockReturnValueOnce(pendingRead.promise);
    openSessionWorkspaceFile(state, { path: "navigation.txt" });
    await renderPanels();
    editor.dispatch({ changes: { from: 0, to: 0, insert: "newer " } });
    await renderPanels();
    sessions.setFile = vi.fn().mockResolvedValue({ file: { hash: "newer-saved" } });
    save.click();
    await vi.waitFor(() => expect(save.disabled).toBe(true));
    pendingRead.resolve({ ...saved, file: { ...saved.file, content: savedText, hash: "saved" } });
    await pendingRead.promise;
    await renderPanels();
    expect(mount.querySelector(".cm-editor")).toBe(editorElement);
    expect(editor.state.doc.toString()).toBe(`newer ${savedText}`);
    savedText = editor.state.doc.toString();
    vi.mocked(sessions.getFile).mockResolvedValue({
      ...saved,
      file: { ...saved.file, content: savedText, hash: "newer-saved" },
    });
    const discard = expectDefined(
      [...mount.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Discard",
      ),
      "Discard action",
    );
    discard.click();
    await renderPanels();
    const raw = expectDefined(
      [...mount.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "View Raw Text",
      ),
      "Raw action",
    );
    raw.click();
    await renderPanels();
    const rawReader = mount.querySelector(".sidebar-markdown-reader");
    expect(rawReader).not.toBeNull();
    openSessionWorkspaceFile(state, { path: "navigation.txt" });
    await renderPanels();
    expect(mount.querySelector(".sidebar-markdown-reader")).toBe(rawReader);
    expect(mount.querySelector(".cm-editor")).toBeNull();
    openSessionWorkspaceFile(state, { path: "navigation.txt", line: 3 });
    await renderPanels();
    await vi.waitFor(() =>
      expect(mount.querySelector(".file-view__line--target")?.getAttribute("data-line")).toBe("3"),
    );
    const restored = expectDefined(
      EditorView.findFromDOM(
        expectDefined(mount.querySelector<HTMLElement>(".cm-editor"), "restored editor"),
      ),
      "restored view",
    );
    expect(restored.state.doc.toString()).toBe(savedText);
  });
  it.each(["ready", "unavailable", "error"] as const)(
    "keeps Files pending during renewed source resolution, then shows %s",
    async (outcome) => {
      const attachmentId = crypto.randomUUID();
      const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
      const container = document.body.appendChild(document.createElement("div"));
      const detail = document.body.appendChild(document.createElement("div"));
      let sidebarContent: SidebarContent | null = null;
      const pending = createDeferred<{ url: string } | null>();
      const secondResolver = vi.fn(() => pending.promise);
      const firstResolver = vi.fn(async () => ({ url: `${source}?mediaTicket=first` }));
      const attachment: AttachmentItem = {
        type: "attachment",
        attachment: {
          kind: "video",
          label: "recording.mp4",
          mimeType: "video/mp4",
          sizeBytes: 574_000,
          url: source,
          artifactId: `artifact_${attachmentId}`,
        },
      };
      const rerender = () =>
        render(
          renderAssistantAttachments(
            [attachment],
            {
              connectionEpoch: 1,
              onRequestUpdate: rerender,
              resolveArtifactDownload: firstResolver,
            },
            (content) => {
              sidebarContent = content;
            },
            undefined,
            false,
          ),
          container,
        );
      onTestFinished(() => releaseChatMediaResourceSubscriber(rerender));
      rerender();
      const open = await vi.waitFor(() =>
        expectDefined(
          container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand"),
          "Open attachment",
        ),
      );
      open.click();
      render(
        html`<openclaw-chat-detail-panel
          .content=${{
            ...expectDefined<SidebarContent>(sidebarContent, "Opened attachment"),
            sourceIdentity: undefined,
          }}
          .attachmentRuntime=${{ connectionEpoch: 2, resolveArtifactDownload: secondResolver }}
        ></openclaw-chat-detail-panel>`,
        detail,
      );
      const panel = expectDefined(
        detail.querySelector<LitElement>("openclaw-chat-detail-panel"),
        "Files panel",
      );
      await panel.updateComplete;

      expect(panel.textContent).toContain("recording.mp4");
      expect(panel.textContent).not.toContain("Preview unavailable");
      expect(panel.querySelector('[aria-busy="true"]')).not.toBeNull();
      const video = await vi.waitFor(() =>
        expectDefined(panel.querySelector("video"), "Pending video"),
      );
      expect(video.hasAttribute("src")).toBe(false);
      expect(video.preload).toBe("auto");
      const presentation = panel.querySelector('[role="status"]');
      const header = panel.querySelector(".chat-assistant-attachment-card__header");
      expect(secondResolver).toHaveBeenCalledOnce();
      if (outcome === "error") {
        pending.reject(new Error("Connection lost"));
      } else {
        pending.resolve(outcome === "ready" ? { url: `${source}?mediaTicket=renewed` } : null);
      }
      if (outcome === "ready") {
        const player = panel.querySelector<LitElement>("openclaw-chat-video-player");
        await player?.updateComplete;
        await vi.waitFor(() =>
          expect(video.getAttribute("src")).toBe(`${source}?mediaTicket=renewed`),
        );
        expect(panel.querySelector("video")).toBe(video);
        expect(panel.querySelector('[role="status"]')).toBe(presentation);
        expect(panel.querySelector(".chat-assistant-attachment-card__header")).toBe(header);
        expect(panel.querySelector('[aria-busy="true"]')).not.toBeNull();
        Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
        video.dispatchEvent(new Event("loadeddata"));
        await player?.updateComplete;
        expect(panel.querySelector('[role="status"]')).toBeNull();
        expect(panel.querySelector('[aria-busy="true"]')).toBeNull();
        expect(panel.textContent).not.toContain("Preview unavailable");
      } else {
        await vi.waitFor(() => expect(panel.textContent).toContain("Preview unavailable"));
        expect(panel.querySelector('[aria-busy="true"]')).toBeNull();
        expect(panel.querySelector("video")).toBeNull();
      }
      detail.remove();
      container.remove();
    },
  );

  it.each(["history", "stream"] as const)(
    "reuses attachment metadata when Open shows %s content in Files",
    async (surface) => {
      installTranscriptDomMocks();
      const { mount, state } = createReviewFixture();
      const transcript = document.body.appendChild(document.createElement("div"));
      const fetchMetadata = vi.fn(() =>
        Promise.resolve(Response.json({ available: true, sizeBytes: 574_000 })),
      );
      // PDF previews fetch bytes separately; an unavailable preview must not refetch metadata.
      const contentRequested = createDeferred();
      const fetchContent = vi.fn<typeof fetch>(async () => {
        contentRequested.resolve();
        return new Response(null, { status: 503 });
      });
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>((input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          return url.searchParams.get("meta") === "1" ? fetchMetadata() : fetchContent(input, init);
        }),
      );
      const filename = surface === "history" ? "recording.mp4" : "report.pdf";
      const source = `/tmp/preview-cache-${surface}/${filename}`;
      const controller = createTestTranscript();
      const chat = {
        ...threadProps(
          `attachment-preview-${surface}`,
          state.sessionKey,
          surface === "history"
            ? [
                {
                  role: "user",
                  content: [
                    {
                      type: "attachment",
                      attachment: {
                        kind: "video",
                        label: filename,
                        mimeType: "video/mp4",
                        url: source,
                      },
                    },
                  ],
                },
              ]
            : [],
        ),
        stream: surface === "stream" ? `MEDIA:${source}` : null,
        streamStartedAt: surface === "stream" ? 1 : null,
        onOpenSidebar: state.handleOpenSidebar,
        sessionKey: state.sessionKey,
        currentAgentId: resolveChatAgentId(state),
        ...resolveChatMessageAccess(state).chatProps,
        connectionEpoch: state.connectionEpoch,
      } as ChatProps;
      const renderAttachment = () => {
        render(
          renderChatThread({ ...chat, onRequestUpdate: renderAttachment }, controller),
          transcript,
        );
        controller.hostUpdated();
      };
      try {
        renderAttachment();
        const open = await vi.waitFor(() => {
          const button = transcript.querySelector<HTMLButtonElement>(
            ".chat-assistant-attachment-card__expand",
          );
          expect(button).not.toBeNull();
          return button!;
        });
        expect(fetchMetadata).toHaveBeenCalledOnce();
        open.click();
        const content = state.sessionWorkspaceState?.previews.at(-1)?.content;
        if (!content || content.kind !== "attachment") {
          throw new Error("Expected an attachment preview");
        }
        render(
          renderChatDetailSlot({
            chat,
            content: content!,
            host: state,
          }),
          mount,
        );
        await mount.querySelector<LitElement>("openclaw-chat-detail-panel")?.updateComplete;
        expect(fetchMetadata).toHaveBeenCalledOnce();
        if (surface === "history") {
          expect(mount.textContent).toContain(filename);
          expect(mount.querySelector("openclaw-chat-video-player")).not.toBeNull();
          expect(fetchContent).not.toHaveBeenCalled();
        } else {
          await contentRequested.promise;
          expect(fetchContent).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining("/__openclaw__/assistant-media?"),
            expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
          );
          await new Promise<void>((resolve) => {
            const settle = () => {
              if (mount.querySelector(".sidebar-pdf-preview [role=alert]")) {
                observer.disconnect();
                resolve();
              }
            };
            const observer = new MutationObserver(settle);
            onTestFinished(() => observer.disconnect());
            observer.observe(mount, { childList: true, subtree: true });
            settle();
          });
          expect(mount.textContent).toContain("Preview unavailable");
          expect(mount.querySelector(".sidebar-pdf-preview")?.getAttribute("aria-label")).toBe(
            filename,
          );
          expect(fetchMetadata).toHaveBeenCalledOnce();
          expect(mount.querySelector<HTMLAnchorElement>("a[download]")?.download).toBe(filename);
        }
      } finally {
        render(nothing, transcript);
        controller.hostDisconnected();
        mount.remove();
        releaseChatMediaResourceSubscriber(renderAttachment);
        resetTranscriptTestDom();
      }
    },
  );

  it("keeps Files closed when a pending file preview completes", async () => {
    const { file, mount, preview, renderPanels, state } = createReviewFixture();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    await renderPanels();
    const close = mount.querySelector<HTMLButtonElement>(
      'button[aria-label="Close tab: preview.png"]',
    );
    expect(close).not.toBeNull();
    close!.click();
    await renderPanels();
    expect(mount.querySelector('[data-panel-slot="detail"]')).toBeNull();

    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(mount.querySelector('[data-panel-slot="detail"]')).toBeNull();
  });

  it("opens the requested file when an unrelated directory listing completes first", async () => {
    const { file, list, mount, preview, renderPanels, state } = createReviewFixture();
    createSessionWorkspaceProps(state).onRefresh();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    await renderPanels();
    expect(mount.querySelector('[data-panel-skeleton="files"]')).not.toBeNull();

    list.resolve({
      sessionKey: state.sessionKey,
      root: "/synthetic/workspace",
      files: [{ kind: "modified", name: "other.txt", path: "other.txt", missing: false }],
      artifacts: [],
    });
    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).list?.files[0]?.name).toBe("other.txt"),
    );
    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(
      mount.querySelector<HTMLImageElement>(
        ".chat-files-panel__page:not([hidden]) .chat-tool-card__preview-image",
      )?.alt,
    ).toBe("preview.png");
  });

  it.each(["Files", "minimized"] as const)(
    "keeps the operator's %s presentation when a pending preview completes",
    async (presentation) => {
      const { file, mount, preview, renderPanels, state } = createReviewFixture();
      openSessionWorkspaceFile(state, { path: preview.file.path });
      await renderPanels();
      if (presentation === "Files") {
        state.handleOpenSidebar({
          kind: "attachment",
          attachmentKind: "image",
          title: "Attachment in Files",
          src: "/synthetic/attachment.png",
        });
      } else {
        state.updateSidebarLayout(setSidebarOpen(state.sidebarLayout, false));
      }
      const layout = state.sidebarLayout;
      await renderPanels();

      file.resolve(preview);
      await file.promise;
      await renderPanels();
      expect(state.sidebarLayout).toEqual(layout);
      expect(isSidebarSlotVisible(state.sidebarLayout, "detail")).toBe(false);
      if (presentation === "Files") {
        expect(
          mount.querySelector<HTMLImageElement>(".sidebar-attachment-preview__image")?.alt,
        ).toBe("Attachment in Files");
      }
      state.sessionWorkspaceState!.activePreviewId = `file:${preview.file.path}`;
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "workspace"));
      await renderPanels();
      expect(
        mount.querySelector<HTMLImageElement>(
          ".chat-files-panel__page:not([hidden]) .chat-tool-card__preview-image",
        )?.alt,
      ).toBe("preview.png");
    },
  );

  it("keeps the newer file visible after an older preview request settles", async () => {
    const { file, mount, preview, renderPanels, sessions, state } = createReviewFixture();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    const replacement = {
      ...preview,
      file: { ...preview.file, name: "replacement.png", path: "replacement.png" },
    };
    sessions.getFile = vi.fn().mockResolvedValue(replacement);
    openSessionWorkspaceFile(state, { path: replacement.file.path });
    await vi.waitFor(async () => {
      await renderPanels();
      expect(
        mount.querySelector<HTMLImageElement>(
          ".chat-files-panel__page:not([hidden]) .chat-tool-card__preview-image",
        )?.alt,
      ).toBe("replacement.png");
    });
    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(
      mount.querySelector<HTMLImageElement>(
        ".chat-files-panel__page:not([hidden]) .chat-tool-card__preview-image",
      )?.alt,
    ).toBe("replacement.png");
  });

  it("retires a preview across reconnect without refocusing Review over Files", async () => {
    const { file, mount, preview, renderPanels, state } = createReviewFixture();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    state.handleOpenSidebar({
      kind: "attachment",
      attachmentKind: "image",
      title: "Attachment in Files",
      src: "/synthetic/attachment.png",
    });
    await renderPanels();
    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);

    state.connectionEpoch += 1;
    await renderPanels();
    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);
    expect(state.sessionWorkspaceState?.previews).toEqual([]);
    expect(mount.querySelector(".sidebar-attachment-preview__image")).toBeNull();
    state.updateSidebarLayout(openSlot(state.sidebarLayout, "detail"));
    await renderPanels();
    expect(mount.querySelector(".chat-tool-card__preview-image")).toBeNull();
  });

  it("shows a current preview request failure without leaving Review loading", async () => {
    const { file, mount, preview, renderPanels, state } = createReviewFixture();
    openSessionWorkspaceFile(state, { path: preview.file.path });
    await renderPanels();
    file.reject(new Error("Preview unavailable"));
    await expect(file.promise).rejects.toThrow("Preview unavailable");
    state.updateSidebarLayout(openSlot(state.sidebarLayout, "workspace"));
    await renderPanels();
    expect(mount.textContent).toContain("Preview unavailable");
    expect(mount.querySelector('[data-panel-skeleton="files"]')).toBeNull();
  });

  it("does not offer Discussion when no provider is available", () => {
    expect(discussionSlots(false)).not.toContain("discussion");
  });

  it("offers Discussion after the provider reports it available", () => {
    expect(discussionSlots(true)).toContain("discussion");
  });

  it("retains default Review content and collapsed files while switching tabs, focusing Chat, and minimizing", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:review",
      branch: "feature/review",
      baseRef: "main",
      additions: 1,
      deletions: 1,
      files: [{ path: "example.txt", status: "modified", additions: 1, deletions: 1 }],
    });
    const state = {
      client: { request },
      connected: true,
      connectionEpoch: 1,
      hello: { features: { methods: ["sessions.diff"] } },
      sessionKey: "agent:main:review",
      sidebarContent: null,
      sidebarLayout: { columns: [] },
      settings: loadSettings(),
    } as unknown as ChatPageHost;
    const mount = document.body.appendChild(document.createElement("div"));
    const renderPanels = async (layout: SidebarLayout) => {
      state.sidebarLayout = layout;
      const definitions = sidebarPanelDefinitions({
        state,
        renderDetail: (content) =>
          html`<openclaw-chat-detail-panel
            .content=${content}
            embedded
          ></openclaw-chat-detail-panel>`,
        workspace: html`<div>Files</div>`,
      } as Parameters<typeof sidebarPanelDefinitions>[0]);
      await renderPanelFixture(mount, layout, definitions);
    };
    const review = openSlot({ columns: [] }, "detail");
    await renderPanels(setSidebarOpen(review, false));
    expect(mount.querySelector("openclaw-session-diff")).toBeNull();
    expect(request).not.toHaveBeenCalled();

    await renderPanels(review);
    await vi.waitFor(() =>
      expect(mount.querySelector(".session-diff__file-toggle")).not.toBeNull(),
    );
    const diff = mount.querySelector("openclaw-session-diff");
    const toggle = mount.querySelector<HTMLButtonElement>(".session-diff__file-toggle")!;
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));

    const focused = setSidebarExpanded(ensureSidebarConversation(review), true);
    for (const layout of [
      openSlot(review, "workspace"),
      review,
      focused,
      setSidebarExpanded(focused, false),
      setSidebarOpen(review, false),
      review,
    ]) {
      await renderPanels(layout);
      expect(mount.querySelector("openclaw-session-diff")).toBe(diff);
      expect(diff?.closest("[data-panel-slot]")?.hasAttribute("hidden")).toBe(
        !isSidebarSlotVisible(layout, "detail"),
      );
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    }
    await renderPanels(closeSlot(review, "detail"));
    expect(mount.querySelector("openclaw-session-diff")).toBeNull();
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.diff", {
      sessionKey: state.sessionKey,
      agentId: "main",
      scope: "all",
    });
    expect(state.sidebarContent).toBeNull();
  });

  it("shows why a file could not open instead of falling back to the session diff", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:review",
      branch: "feature/review",
      baseRef: "main",
      additions: 1,
      deletions: 1,
      files: [{ path: "example.txt", status: "modified", additions: 1, deletions: 1 }],
    });
    const { mount, renderPanels, state } = createReviewFixture();
    const message = 'Failed to load docs/chat.md: <img src="missing.png">';
    state.client = createGatewayBrowserClientFixture({
      request: (method, params) =>
        method === "tasks.list" ? { tasks: [] } : request(method, params),
    });
    state.hello = gatewayHelloForMethods(["sessions.diff"]);
    state.sessionKey = "agent:main:review";
    state.sidebarContent = { kind: "unavailable", message };
    state.updateSidebarLayout(openSlot(state.sidebarLayout, "detail"));
    await renderPanels();

    const notice = mount.querySelector(".review-unavailable");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.classList.contains("danger")).toBe(true);
    expect(notice?.querySelector("strong")?.textContent).toBe("Unable to open");
    expect(notice?.querySelector("span")?.textContent).toBe(message);
    expect(notice?.querySelector("img")).toBeNull();
    expect(mount.querySelector("openclaw-session-diff")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("enumerates a structural loading variant for every side-panel tab", async () => {
    const expected = {
      browser: "browser",
      "link-reader": "files",
      companion: "chat",
      conversation: "chat",
      dashboard: "board",
      desktop: "desktop",
      detail: "review",
      discussion: "discussion",
      portal: "browser",
      tasks: "tasks",
      terminal: "terminal",
      workspace: "files",
    } as const;

    const definitions = sidebarPanelDefinitions();
    expect(definitions.map((definition) => definition.slot)).toEqual([
      "conversation",
      "detail",
      "terminal",
      "browser",
      "link-reader",
      "portal",
      "workspace",
      "companion",
      "tasks",
      "desktop",
      "discussion",
      "dashboard",
    ]);
    for (const definition of definitions) {
      const mount = document.body.appendChild(document.createElement("div"));
      render(definition.loading, mount);
      const skeleton = mount.querySelector("openclaw-panel-loading-skeleton");
      await skeleton?.updateComplete;
      expect(skeleton?.getAttribute("data-panel-skeleton")).toBe(
        expected[definition.slot as keyof typeof expected],
      );
    }
  });

  it("exposes task refresh in the shared side-panel header", () => {
    const onRefreshTasks = vi.fn();
    const params = {} as NonNullable<Parameters<typeof sidebarPanelDefinitions>[0]>;
    params.connected = true;
    params.companion = { turns: [], loading: false, draft: "" };
    params.onRefreshTasks = onRefreshTasks;
    params.tasksLoading = false;
    const tasks = sidebarPanelDefinitions(params).find((definition) => definition.slot === "tasks");
    const mount = document.body.appendChild(document.createElement("div"));
    render(tasks?.headerAction, mount);

    const refresh = mount.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh background tasks"]',
    );
    expect(refresh).not.toBeNull();
    expect(refresh?.querySelector("svg")?.outerHTML).toContain("M21 12a9");
    refresh?.click();
    expect(onRefreshTasks).toHaveBeenCalledOnce();

    for (const [connected, tasksLoading] of [
      [false, false],
      [true, true],
    ] as const) {
      params.connected = connected;
      params.tasksLoading = tasksLoading;
      const definition = sidebarPanelDefinitions(params).find(
        (candidate) => candidate.slot === "tasks",
      );
      render(definition?.headerAction, mount);
      expect(
        mount.querySelector<HTMLButtonElement>('button[aria-label="Refresh background tasks"]')
          ?.disabled,
      ).toBe(true);
      if (tasksLoading) {
        expect(
          mount.querySelector(
            'button[aria-label="Refresh background tasks"] .btn__spinner[aria-hidden="true"]',
          ),
        ).not.toBeNull();
      }
    }
  });
});
