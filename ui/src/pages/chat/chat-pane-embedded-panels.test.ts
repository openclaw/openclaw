/* @vitest-environment jsdom */

import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, createSignal } from "solid-js";
import "./components/chat-detail-panel.tsx";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult } from "../../api/types.ts";
import * as videoPosters from "../../lib/media/video-poster.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../lib/presentation.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  createReviewFixture as createUnboundReviewFixture,
  renderPanelFixture,
  sidebarPanelFixtureParams,
} from "../../test-helpers/chat-pane-embedded-panels.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { createSidebarFullMessageLoader } from "./chat-pane-sidebar-layout.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import type { ChatProps } from "./chat-view.tsx";
import { ChatDetailSlot } from "./components/chat-detail-slot-view.tsx";
import { AssistantAttachments } from "./components/chat-message-attachments-solid.tsx";
import {
  releaseChatMediaResourceOwner,
  type AttachmentItem,
} from "./components/chat-message-media.ts";
import {
  clearSessionWorkspacePreviews,
  getSessionWorkspace,
  loadSessionWorkspace,
  openSessionWorkspacePreview,
} from "./components/chat-session-workspace-state.ts";
import { loadedSidebarContent } from "./components/chat-session-workspace.test-support.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
} from "./components/chat-session-workspace.ts";
import type { SidebarContent } from "./components/chat-sidebar-content-types.ts";
import { createChatSidebarContainer } from "./components/chat-sidebar.test-support.ts";
import { ChatThread } from "./components/chat-thread-view.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";
import "./components/chat-sidebar-region.runtime.tsx";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  setSidebarExpanded,
  setSidebarOpen,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function createReviewFixture() {
  const fixture = createUnboundReviewFixture();
  const provider = createChatSidebarContainer();
  fixture.mount.before(provider);
  provider.append(fixture.mount);
  const query: typeof fixture.mount.querySelector = fixture.mount.querySelector.bind(fixture.mount);
  return {
    query,
    ...fixture,
    previewAlt: () =>
      query<HTMLImageElement>(".chat-files-panel__page:not([hidden]) .sidebar-image-view img")?.alt,
    settlePreview: async () => {
      fixture.file.resolve(fixture.preview);
      await fixture.file.promise;
      await fixture.renderPanels();
    },
  };
}

function buttonWithText(root: ParentNode, label: string) {
  return expectDefined(
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ),
    `${label} action`,
  );
}

function element(root: ParentNode, selector: string): HTMLElement {
  return expectDefined(root.querySelector<HTMLElement>(selector), selector);
}

function videoAttachment(
  url: string,
  overrides: Partial<AttachmentItem["attachment"]> = {},
): AttachmentItem {
  return {
    type: "attachment",
    attachment: {
      kind: "video",
      label: "recording.mp4",
      mimeType: "video/mp4",
      url,
      ...overrides,
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

it("renders and updates the workspace rail inside the Files panel", async () => {
  const { list, mount, renderPanels, sessions, state, query } = createReviewFixture();
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "workspace"));
  loadSessionWorkspace(state, getSessionWorkspace(state), true);
  list.resolve({
    sessionKey: state.sessionKey,
    root: "/synthetic/workspace",
    files: [{ kind: "read", name: "notes.txt", path: "notes.txt", missing: false }],
    artifacts: [],
  });
  await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
  await renderPanels();
  const rail = element(mount, "openclaw-chat-files-panel .chat-workspace-rail");
  expect(rail.querySelector('button[aria-label="notes.txt"]')).not.toBeNull();
  getSessionWorkspace(state).browserSearch = "notes";
  await renderPanels();
  expect(query(".chat-workspace-rail")).toBe(rail);
  expect(rail.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("notes");
  element(rail, 'button[aria-label="notes.txt"]').click();
  expect(sessions.getFile).toHaveBeenCalledExactlyOnceWith(state.sessionKey, "notes.txt", {
    agentId: "main",
  });
});

it("navigates an existing file tab to an explicit line without resetting its editor or draft", async () => {
  for (const [key, value] of Object.entries({
    getClientRects: () => [],
    getBoundingClientRect: () => new DOMRect(),
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, key);
    Object.defineProperty(Range.prototype, key, { configurable: true, value });
    onTestFinished(() => {
      if (descriptor) {
        Object.defineProperty(Range.prototype, key, descriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, key);
      }
    });
  }
  const { file, mount, renderPanels, state, sessions, query } = createReviewFixture();
  const navigate = async (line?: number) => {
    await openSessionWorkspaceFile(state, {
      path: "navigation.txt",
      ...(line === undefined ? {} : { line }),
    });
    await renderPanels();
  };
  const expectLine = (line: number) =>
    vi.waitFor(() =>
      expect(query(".file-view__line--target")?.getAttribute("data-line")).toBe(String(line)),
    );
  state.hello = gatewayHelloForMethods(["sessions.files.get", "sessions.files.set"]);
  const text = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
  void openSessionWorkspaceFile(state, { path: "navigation.txt", line: 2 });
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
  // The panel commit does not include the editor's detached module load.
  await vi.dynamicImportSettled();
  const editorElement = await vi.waitFor(() => element(mount, ".cm-editor"));
  const editor = expectDefined(EditorView.findFromDOM(editorElement), "CodeMirror view");
  await expectLine(2);
  element(mount, '[aria-label="Edit file"]').click();
  await renderPanels();
  editor.dispatch({ changes: { from: 0, to: 0, insert: "draft " } });
  const draft = editor.state.doc.toString();
  const scroll = vi.spyOn(EditorView, "scrollIntoView");
  onTestFinished(() => scroll.mockRestore());
  await navigate(7);
  await expectLine(7);
  expect(query(".cm-editor")).toBe(editorElement);
  expect(editor.state.doc.toString()).toBe(draft);
  expect(scroll).toHaveBeenCalled();
  scroll.mockClear();
  await navigate(7);
  expect(scroll).toHaveBeenCalled();
  expect(editor.contentDOM.getAttribute("contenteditable")).toBe("true");
  expect(undo(editor)).toBe(true);
  expect(editor.state.doc.toString()).toBe(text);
  expect(sessions.getFile).toHaveBeenCalledOnce();
  expect(state.sessionWorkspaceState?.previews).toHaveLength(1);
  scroll.mockClear();
  editor.scrollDOM.scrollTop = 123;
  await navigate();
  expect(query(".cm-editor")).toBe(editorElement);
  expect(editor.scrollDOM.scrollTop).toBe(123);
  expect(scroll).not.toHaveBeenCalled();
  sessions.setFile = vi.fn().mockResolvedValue({ file: { hash: "saved" } });
  editor.dispatch({ changes: { from: 0, to: 0, insert: "saved " } });
  await renderPanels();
  const save = buttonWithText(mount, "Save");
  save.click();
  await vi.waitFor(() => expect(save.disabled).toBe(true));
  let savedText = editor.state.doc.toString();
  const saved = (await file.promise)!;
  const pendingRead = createDeferred<SessionWorkspaceGetResult | null>();
  vi.mocked(sessions.getFile).mockReturnValueOnce(pendingRead.promise);
  void openSessionWorkspaceFile(state, { path: "navigation.txt" });
  await renderPanels();
  editor.dispatch({ changes: { from: 0, to: 0, insert: "newer " } });
  await renderPanels();
  sessions.setFile = vi.fn().mockResolvedValue({ file: { hash: "newer-saved" } });
  save.click();
  await vi.waitFor(() => expect(save.disabled).toBe(true));
  pendingRead.resolve({ ...saved, file: { ...saved.file, content: savedText, hash: "saved" } });
  await pendingRead.promise;
  await renderPanels();
  expect(query(".cm-editor")).toBe(editorElement);
  expect(editor.state.doc.toString()).toBe(`newer ${savedText}`);
  savedText = editor.state.doc.toString();
  vi.mocked(sessions.getFile).mockResolvedValue({
    ...saved,
    file: { ...saved.file, content: savedText, hash: "newer-saved" },
  });
  buttonWithText(mount, "Discard").click();
  await renderPanels();
  const highlighting = expectDefined(
    query<HTMLButtonElement>('button[aria-label="Syntax highlighting"]'),
    "Syntax highlighting action",
  );
  expect(highlighting.getAttribute("aria-pressed")).toBe("true");
  highlighting.click();
  await renderPanels();
  expect(highlighting.getAttribute("aria-pressed")).toBe("false");
  expect(query(".cm-editor")).toBe(editorElement);
  editor.scrollDOM.scrollTop = 123;
  await navigate();
  expect(highlighting.getAttribute("aria-pressed")).toBe("false");
  expect(query(".cm-editor")).toBe(editorElement);
  expect(editor.scrollDOM.scrollTop).toBe(123);
  await navigate(3);
  await expectLine(3);
  const restored = expectDefined(
    EditorView.findFromDOM(element(mount, ".cm-editor")),
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
    const detail = document.body.appendChild(createChatSidebarContainer());
    let sidebarContent: SidebarContent | null = null;
    const pending = createDeferred<{ url: string } | null>();
    const secondResolver = vi.fn(() => pending.promise);
    const firstResolver = vi.fn(async () => ({ url: `${source}?mediaTicket=first` }));
    const attachment = videoAttachment(source, {
      sizeBytes: 574_000,
      artifactId: `artifact_${attachmentId}`,
    });
    let rerender = () => {};
    mountSolid(
      () => {
        const [revision, setRevision] = createSignal(0);
        rerender = () => setRevision((value) => value + 1);
        return createComponent(AssistantAttachments, {
          attachments: [attachment],
          get options() {
            revision();
            return {
              connectionEpoch: 1,
              mediaOwner: rerender,
              resolveArtifactDownload: firstResolver,
            };
          },
          onOpenSidebar: (content) => {
            sidebarContent = content;
          },
          inlinePlayback: false,
        });
      },
      { container },
    );
    onTestFinished(() => releaseChatMediaResourceOwner(rerender));
    const open = await vi.waitFor(() =>
      element(container, ".chat-assistant-attachment-card__expand"),
    );
    open.click();
    const opened = expectDefined<SidebarContent>(sidebarContent, "Opened attachment");
    if (opened.kind !== "attachment") {
      throw new Error("Expected an attachment preview");
    }
    mountSolid(
      () => {
        const panel = document.createElement("openclaw-chat-detail-panel");
        panel.content = { ...opened, sourceIdentity: undefined };
        panel.attachmentRuntime = {
          connectionEpoch: 2,
          resolveArtifactDownload: secondResolver,
        };
        return panel;
      },
      { container: detail },
    );
    const panel = expectDefined(detail.querySelector("openclaw-chat-detail-panel"), "Files panel");
    await panel.updateComplete;

    expect(panel.textContent).toContain("recording.mp4");
    expect(panel.textContent).not.toContain("Preview unavailable");
    expect(panel.querySelector('[aria-busy="true"]')).not.toBeNull();
    const video = await vi.waitFor(() => expectDefined(panel.querySelector("video"), "video"));
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
      const player = panel.querySelector("openclaw-chat-video-player");
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
    vi.spyOn(videoPosters, "requestVideoPoster").mockResolvedValue(null);
    const { context, mount, state, query } = createReviewFixture();
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
          ? [{ role: "user", content: [videoAttachment(source, { label: filename })] }]
          : [],
      ),
      stream: surface === "stream" ? `MEDIA:${source}` : null,
      streamStartedAt: surface === "stream" ? 1 : null,
      onOpenSidebar: state.handleOpenSidebar,
      sessionKey: state.sessionKey,
      currentAgentId: resolveChatAgentId(state),
      fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
      loadFullAssistantMessage: createSidebarFullMessageLoader(state, context.gateway),
      connectionEpoch: state.connectionEpoch,
      mediaOwner: renderAttachment,
    } as ChatProps;
    const [current, setCurrent] = createSignal(chat);
    const application = createSolidApplicationContextProvider(context);
    const view = mountSolid(
      () =>
        createComponent(ChatThread, {
          get props() {
            return current();
          },
          transcript: controller,
        }),
      { container: transcript, wrapper: application.wrapper },
    );
    function renderAttachment() {
      setCurrent({ ...chat });
      flush();
      controller.update();
    }
    controller.start();
    try {
      renderAttachment();
      const open = await vi.waitFor(() =>
        element(transcript, ".chat-assistant-attachment-card__expand"),
      );
      expect(fetchMetadata).toHaveBeenCalledOnce();
      open.click();
      const content = state.sessionWorkspaceState?.previews.at(-1)?.content;
      if (!content || content.kind !== "attachment") {
        throw new Error("Expected an attachment preview");
      }
      mountSolid(
        () =>
          createComponent(ChatDetailSlot, {
            chat,
            content,
            host: state,
          }),
        { container: mount, wrapper: application.wrapper },
      );
      await query("openclaw-chat-detail-panel")?.updateComplete;
      expect(fetchMetadata).toHaveBeenCalledOnce();
      if (surface === "history") {
        expect(mount.textContent).toContain(filename);
        expect(query("openclaw-chat-video-player")).not.toBeNull();
        expect(fetchContent).not.toHaveBeenCalled();
      } else {
        await contentRequested.promise;
        expect(fetchContent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("/__openclaw__/assistant-media?"),
          expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
        );
        await new Promise<void>((resolve) => {
          const settle = () => {
            if (query(".sidebar-pdf-preview [role=alert]")) {
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
        expect(query(".sidebar-pdf-preview")?.getAttribute("aria-label")).toBe(filename);
        expect(fetchMetadata).toHaveBeenCalledOnce();
        expect(query<HTMLAnchorElement>("a[download]")?.download).toBe(filename);
      }
    } finally {
      view.unmount();
      controller.dispose();
      mount.remove();
      releaseChatMediaResourceOwner(renderAttachment);
      resetTranscriptTestDom();
    }
  },
);

it("keeps Files closed when a pending file preview completes", async () => {
  const { preview, renderPanels, settlePreview, state, query } = createReviewFixture();
  void openSessionWorkspaceFile(state, { path: preview.file.path });
  await renderPanels();
  const close = query<HTMLButtonElement>('button[aria-label="Close tab: preview.png"]');
  expect(close).not.toBeNull();
  close!.click();
  await renderPanels();
  expect(query('[data-panel-slot="detail"]')).toBeNull();

  await settlePreview();
  expect(query('[data-panel-slot="detail"]')).toBeNull();
});

it("opens the requested file when an unrelated directory listing completes first", async () => {
  const { file, list, preview, previewAlt, renderPanels, state, query } = createReviewFixture();
  loadSessionWorkspace(state, getSessionWorkspace(state), true);
  void openSessionWorkspaceFile(state, { path: preview.file.path });
  await renderPanels();
  expect(query('[data-panel-skeleton="files"]')).not.toBeNull();

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
  await loadedSidebarContent(state);
  await renderPanels();
  expect(previewAlt()).toBe("preview.png");
});

it.each(["Files", "minimized"] as const)(
  "keeps the operator's %s presentation when a pending preview completes",
  async (presentation) => {
    const { preview, previewAlt, renderPanels, settlePreview, state, query } =
      createReviewFixture();
    void openSessionWorkspaceFile(state, { path: preview.file.path });
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

    await settlePreview();
    expect(state.sidebarLayout).toEqual(layout);
    expect(isSidebarSlotVisible(state.sidebarLayout, "detail")).toBe(false);
    if (presentation === "Files") {
      expect(query<HTMLImageElement>(".sidebar-attachment-preview__image")?.alt).toBe(
        "Attachment in Files",
      );
    }
    state.sessionWorkspaceState!.activePreviewId = `file:${preview.file.path}`;
    state.updateSidebarLayout(openSlot(state.sidebarLayout, "workspace"));
    await renderPanels();
    expect(previewAlt()).toBe("preview.png");
  },
);

it("keeps the newer file visible after an older preview request settles", async () => {
  const { preview, previewAlt, renderPanels, sessions, settlePreview, state } =
    createReviewFixture();
  void openSessionWorkspaceFile(state, { path: preview.file.path });
  const replacement = {
    ...preview,
    file: { ...preview.file, name: "replacement.png", path: "replacement.png" },
  };
  sessions.getFile = vi.fn().mockResolvedValue(replacement);
  await openSessionWorkspaceFile(state, { path: replacement.file.path });
  await vi.waitFor(async () => {
    await renderPanels();
    expect(previewAlt()).toBe("replacement.png");
  });
  await settlePreview();
  expect(previewAlt()).toBe("replacement.png");
});

it("retires a preview across reconnect without refocusing Review over Files", async () => {
  const { preview, renderPanels, settlePreview, state, query } = createReviewFixture();
  void openSessionWorkspaceFile(state, { path: preview.file.path });
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
  await settlePreview();
  expect(isSidebarSlotVisible(state.sidebarLayout, "workspace")).toBe(true);
  expect(state.sessionWorkspaceState?.previews).toEqual([]);
  expect(query(".sidebar-attachment-preview__image")).toBeNull();
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "detail"));
  await renderPanels();
  expect(query(".sidebar-image-view img")).toBeNull();
});

it("shows a current preview request failure without leaving Review loading", async () => {
  const { file, mount, preview, renderPanels, state, query } = createReviewFixture();
  void openSessionWorkspaceFile(state, { path: preview.file.path });
  await renderPanels();
  file.reject(new Error("Preview unavailable"));
  await expect(file.promise).rejects.toThrow("Preview unavailable");
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "workspace"));
  await renderPanels();
  expect(mount.textContent).toContain("Preview unavailable");
  expect(query('[data-panel-skeleton="files"]')).toBeNull();
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
  const mount = document.body.appendChild(createChatSidebarContainer());
  const query: typeof mount.querySelector = mount.querySelector.bind(mount);
  const state = createPageState(
    createInitializationContext(),
    { afterCommit: () => () => {} },
    mount,
  );
  Object.assign(state, {
    client: { request },
    connected: true,
    connectionEpoch: 1,
    hello: { features: { methods: ["sessions.diff"] } },
    sessionKey: "agent:main:review",
    sidebarLayout: { columns: [] },
  });
  let presented = true;
  const owner = new EventTarget();
  const renderPanels = async (layout: SidebarLayout) => {
    state.sidebarLayout = layout;
    const definitions = sidebarPanelDefinitions(
      sidebarPanelFixtureParams(state, {
        panePresentation: { owner, isPresented: () => presented },
      }),
    );
    await renderPanelFixture(mount, layout, definitions);
  };
  const review = openSlot({ columns: [] }, "detail");
  await renderPanels(setSidebarOpen(review, false));
  expect(query("openclaw-session-diff")).toBeNull();
  expect(request).not.toHaveBeenCalled();

  await renderPanels(review);
  await vi.waitFor(() => expect(query(".session-diff__file-toggle")).not.toBeNull());
  const diff = query("openclaw-session-diff");
  const toggle = query<HTMLButtonElement>(".session-diff__file-toggle")!;
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
    expect(query("openclaw-session-diff")).toBe(diff);
    expect(diff?.closest("[data-panel-slot]")?.hasAttribute("hidden")).toBe(
      !isSidebarSlotVisible(layout, "detail"),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  }
  openSessionWorkspacePreview(state, "transient", "Transient preview", {
    kind: "markdown",
    content: "Transient file preview",
  });
  const filesLayout = openSlot(review, "workspace");
  await renderPanels(filesLayout);
  const files = expectDefined(query("openclaw-chat-files-panel"), "Files panel");
  const browser = files.querySelector(".chat-files-panel__page");
  const preview = expectDefined(files.querySelector("openclaw-chat-detail-panel"), "File preview");
  expect(preview.textContent).toContain("Transient file preview");

  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  clearSessionWorkspacePreviews(state);
  await files.updateComplete;
  expect(preview.isConnected).toBe(false);
  expect(files).toMatchObject({ previews: [], activeId: null });
  expect(query("openclaw-chat-files-panel")).toBe(files);
  expect(files.querySelector(".chat-files-panel__page")).toBe(browser);
  expect(query("openclaw-session-diff")).toBe(diff);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  presented = true;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  await renderPanels(filesLayout);
  expect(files.querySelector("openclaw-chat-detail-panel")).toBeNull();
  expect(files.querySelector(".chat-files-panel__page")).toBe(browser);
  await renderPanels(closeSlot(review, "detail"));
  expect(query("openclaw-session-diff")).toBeNull();
  expect(request).toHaveBeenCalledExactlyOnceWith("sessions.diff", {
    sessionKey: state.sessionKey,
    agentId: "main",
    scope: "all",
  });
  expect(state.sidebarContent).toBeNull();
  state.sidebarContent = { kind: "markdown", content: "Transient Review selection" };
  await renderPanels(review);
  const selectedReview = expectDefined(
    query("openclaw-chat-detail-panel"),
    "Selected Review content",
  );
  expect(selectedReview.textContent).toContain("Transient Review selection");
  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  state.sidebarContent = null;
  await waitForSolid(() => expect(selectedReview.isConnected).toBe(false));
});

it("shows why a file could not open instead of falling back to the session diff", async () => {
  const request = vi.fn();
  const { renderPanels, state, query } = createReviewFixture();
  const message = 'Failed to load docs/chat.md: <img src="missing.png">';
  state.client = createGatewayBrowserClientFixture({
    request: (method, params) => request(method, params),
  });
  state.hello = gatewayHelloForMethods(["sessions.diff"]);
  state.sessionKey = "agent:main:review";
  state.sidebarContent = { kind: "unavailable", message };
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "detail"));
  await renderPanels();

  const notice = query(".review-unavailable");
  expect(notice?.getAttribute("role")).toBe("alert");
  expect(notice?.classList.contains("danger")).toBe(true);
  expect(notice?.querySelector("strong")?.textContent).toBe("Unable to open");
  expect(notice?.querySelector("span")?.textContent).toBe(message);
  expect(notice?.querySelector("img")).toBeNull();
  expect(query("openclaw-session-diff")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
