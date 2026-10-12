/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openEditor } from "../../../lib/editor-links.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import "./chat-detail-panel.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import type { FileEditorViewHandle } from "./file-editor-view.ts";

// mock-isolation: These sidebar contracts exclude CodeMirror's browser layout and language loading.
vi.mock("./file-editor-view.ts", () => ({
  createFileEditorView: async ({ content }: { content: string }) => {
    let text = content;
    return {
      destroy() {},
      setContent(next: string) {
        text = next;
      },
      contentEquals: (next: string) => text === next,
      getContent: () => text,
      setEditable() {},
      setLineWrapping() {},
      setDecorations() {},
      scrollToLine() {},
      onDocChanged() {},
      focus() {},
    } satisfies FileEditorViewHandle;
  },
}));

type DetailPanel = HTMLElement & {
  content: unknown;
  basePath?: string;
  execNode: string | null;
  updateComplete: Promise<unknown>;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onOpenSessionLink?: (target: { sessionKey: string; agentId: string }) => void;
  onOpenImage?: (item: { src: string; title: string }) => void;
  embedSandboxMode: "trusted";
  canvasPluginSurfaceUrl: string;
};

let container: HTMLElement;
beforeEach(() => {
  container = createChatSidebarContainer();
  document.body.append(container);
});
afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

describe("openEditor", () => {
  it.each([
    [
      "Windows path",
      "vscode",
      "C:\\workspace\\src\\foo.ts",
      42,
      "vscode://file/C:/workspace/src/foo.ts:42",
    ],
    [
      "URL-significant characters",
      "windsurf",
      "/workspace/#notes?.md",
      undefined,
      "windsurf://file/workspace/%23notes%3F.md",
    ],
  ] as const)("opens the encoded custom URL for %s", (_name, editor, path, line, expected) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openEditor(editor, path, line);
    expect(open).toHaveBeenCalledWith(expected);
    open.mockRestore();
  });
});

describe("file sidebar editor locality", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    clearNativeGatewayTestState();
  });

  it("offers editors for native-local files", async () => {
    setNativeGatewayTestState("local");
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.execNode = null;
    panel.content = {
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      root: "/workspace",
      content: "const answer = 42;",
    };
    container.append(panel);
    await panel.updateComplete;

    expect(panel.querySelector('[aria-label="Open in editor"]')).not.toBeNull();
    expect(panel.querySelectorAll(".sidebar-file-view__editor-item")).toHaveLength(4);
    expect(panel.querySelector(".sidebar-file-view__editor")).not.toBeNull();
  });

  it("removes editor controls when the native gateway switches to remote", async () => {
    setNativeGatewayTestState("local");
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.content = {
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      root: "/workspace",
      content: "const answer = 42;",
    };
    container.append(panel);
    await panel.updateComplete;
    expect(panel.querySelector('[aria-label="Open in editor"]')).not.toBeNull();

    setNativeGatewayTestState("remote");
    await panel.updateComplete;

    expect(panel.querySelector('[aria-label="Open in editor"]')).toBeNull();
    expect(panel.querySelector(".sidebar-file-view__editor")).toBeNull();
  });
});

describe("markdown sidebar", () => {
  it.each([
    { kind: "markdown", trailingNewline: false },
    { kind: "file", trailingNewline: true },
  ] as const)("keeps nested code literal when viewing raw $kind text", async (testCase) => {
    const source =
      ["Intro", "", "```ts", "const x = 1;", "```", "", "**literal after**"].join("\n") +
      (testCase.trailingNewline ? "\n" : "");
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.content =
      testCase.kind === "markdown"
        ? { kind: "markdown", content: "Rendered summary", rawText: source }
        : { kind: "file", path: "notes.md", name: "notes.md", language: "md", content: source };
    container.append(panel);
    const schedule = vi.spyOn(globalThis, "setTimeout");
    try {
      await panel.updateComplete;
      const rawButton = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "View Raw Text",
      );
      expect(rawButton).toBeDefined();
      rawButton!.click();
      await panel.updateComplete;

      expect(panel.querySelector(".sidebar-title")?.textContent?.trim()).toBe("Source");
      expect(panel.querySelector(".sidebar-markdown-shell__eyebrow")?.textContent?.trim()).toBe(
        "Source",
      );
      expect(panel.querySelector(".sidebar-markdown-shell__hint")).toBeNull();
      expect(panel.querySelector(".sidebar-markdown-shell__toolbar button")).toBeNull();

      const reader = panel.querySelector(".sidebar-markdown-reader");
      const copyButton = reader?.querySelector<HTMLButtonElement>(".code-block-copy");
      expect(copyButton).toBeInstanceOf(HTMLButtonElement);
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      copyButton!.click();
      await vi.waitFor(() => expect(copyButton!.getAttribute("aria-label")).toBe("Copied!"));
      expect(writeText).toHaveBeenCalledOnce();

      expect.soft(reader?.querySelectorAll("pre code")).toHaveLength(1);
      expect.soft(reader?.querySelector("pre code")?.textContent).toBe(`${source}\n`);
      expect.soft(reader?.querySelector("strong")).toBeNull();
      expect.soft(writeText).toHaveBeenCalledWith(source);

      panel.content = { kind: "markdown", content: "## Fresh preview" };
      await panel.updateComplete;
      expect(panel.querySelector(".sidebar-markdown-shell__eyebrow")?.textContent?.trim()).toBe(
        "Rendered Markdown",
      );
      expect(panel.querySelector(".sidebar-markdown-reader h2")?.textContent).toBe("Fresh preview");
      expect(
        panel.querySelector(".sidebar-markdown-shell__toolbar button")?.textContent?.trim(),
      ).toBe("View Raw Text");
    } finally {
      for (const [index, [, delay]] of schedule.mock.calls.entries()) {
        if (delay === 1_500) {
          globalThis.clearTimeout(schedule.mock.results[index]?.value);
        }
      }
      schedule.mockRestore();
      panel.remove();
    }
  });

  it.each([undefined, "agent:research:report"])(
    "opens workspace files from markdown previews owned by %s",
    async (sessionKey) => {
      const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
      const onOpenWorkspaceFile = vi.fn();
      panel.content = {
        kind: "markdown",
        content: "See `ui/src/pages/chat/chat-view.ts:362`",
        fileLinkSessionKey: sessionKey,
      };
      panel.onOpenWorkspaceFile = onOpenWorkspaceFile;
      container.append(panel);
      await panel.updateComplete;

      panel.querySelector<HTMLAnchorElement>("a.markdown-file-link")?.click();

      expect(onOpenWorkspaceFile).toHaveBeenCalledWith({
        path: "ui/src/pages/chat/chat-view.ts",
        line: 362,
        ...(sessionKey ? { sessionKey } : {}),
      });
      panel.remove();
    },
  );

  it.each([
    ["a Hebrew heading behind Markdown punctuation as rtl", "## כותרת ראשית", "rtl"],
  ] as const)("renders %s", async (_name, markdown, expected) => {
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.content = { kind: "markdown", content: markdown };
    container.append(panel);
    await panel.updateComplete;

    expect(panel.querySelector(".sidebar-markdown-reader")?.getAttribute("dir")).toBe(expected);
    panel.remove();
  });

  it("opens focused markdown preview file links with Enter", async () => {
    const key = "Enter";
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    const onOpenWorkspaceFile = vi.fn();
    panel.content = { kind: "markdown", content: "See `ui/src/pages/chat/chat-view.ts:362`" };
    panel.onOpenWorkspaceFile = onOpenWorkspaceFile;
    container.append(panel);
    await panel.updateComplete;

    const link = panel.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    link?.focus();
    expect(document.activeElement).toBe(link);
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenWorkspaceFile).toHaveBeenCalledOnce();
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({
      path: "ui/src/pages/chat/chat-view.ts",
      line: 362,
    });
    panel.remove();
  });

  it("handles markdown preview session links with click", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    const onOpenSessionLink = vi.fn();
    const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
    panel.content = { kind: "markdown", content: `Open \`${sessionKey}\`` };
    panel.onOpenSessionLink = onOpenSessionLink;
    container.append(panel);
    await panel.updateComplete;

    const link = panel.querySelector<HTMLAnchorElement>("a.markdown-session-link");
    link?.setAttribute("href", "/chat/roboclaw/2139bddb");
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    link?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    expect(onOpenSessionLink).toHaveBeenCalledWith({ sessionKey, agentId: "roboclaw" });
    panel.remove();
  });

  it.each(["click", "Enter"])(
    "SPA-routes markdown preview session hrefs with %s",
    async (action) => {
      const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
      const onOpenSessionLink = vi.fn();
      const literalUuid = "12345678-90ab-cdef-1234-567890abcdef";
      const href = `${window.location.origin}/control/dashboard/main/~key/${literalUuid}`;
      panel.basePath = "/control";
      panel.content = { kind: "markdown", content: `[Open session](${href})` };
      panel.onOpenSessionLink = onOpenSessionLink;
      container.append(panel);
      await panel.updateComplete;

      const link = panel.querySelector<HTMLAnchorElement>(`a[href^="${window.location.origin}"]`);
      const event =
        action === "click"
          ? new MouseEvent("click", { bubbles: true, button: 0, cancelable: true })
          : new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      link?.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(onOpenSessionLink).toHaveBeenCalledWith({
        namespace: "dashboard",
        pathname: `/control/dashboard/main/~key/${literalUuid}`,
      });
      panel.remove();
    },
  );

  it("activates Markdown images only when a chat owner opts in", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    const onOpenImage = vi.fn();
    panel.content = { kind: "markdown", content: "![Preview](data:image/png;base64,cG5n)" };
    panel.onOpenImage = onOpenImage;
    container.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLButtonElement>(".markdown-inline-image-button")?.click();
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "data:image/png;base64,cG5n",
      title: "Preview",
    });
    panel.remove();

    const fallbackPanel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    fallbackPanel.content = {
      kind: "markdown",
      content: "![Preview](data:image/png;base64,cG5n)",
    };
    container.append(fallbackPanel);
    await fallbackPanel.updateComplete;
    expect(fallbackPanel.querySelector(".markdown-inline-image-button")).toBeNull();
    fallbackPanel.remove();
  });

  it("opens image artifacts through the shared lightbox callback", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    const onOpenImage = vi.fn();
    panel.content = {
      kind: "image",
      title: "Artifact preview",
      src: "data:image/png;base64,cG5n",
    };
    panel.onOpenImage = onOpenImage;
    container.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLButtonElement>(".chat-tool-card__preview-image-button")?.click();

    expect(onOpenImage).toHaveBeenCalledWith({
      src: "data:image/png;base64,cG5n",
      title: "Artifact preview",
    });
    panel.remove();

    const fallbackPanel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    fallbackPanel.content = {
      kind: "image",
      title: "Artifact preview",
      src: "data:image/png;base64,cG5n",
    };
    container.append(fallbackPanel);
    await fallbackPanel.updateComplete;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    fallbackPanel
      .querySelector<HTMLButtonElement>(".chat-tool-card__preview-image-button")
      ?.click();
    expect(openSpy).toHaveBeenCalledWith(
      "data:image/png;base64,cG5n",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
    fallbackPanel.remove();
  });

  it("preserves authenticated transcoded video playback in Files", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.content = {
      kind: "attachment",
      title: "clip.mov",
      src: "/api/chat/media/outgoing/session/artifact/full?mediaTicket=ticket",
      sourceIdentity: "artifact:clip",
      mimeType: "video/quicktime",
      playback: "transcode",
      authToken: "session-token",
      width: 9,
      height: 16,
    };
    container.append(panel);
    await panel.updateComplete;

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof Request ? url.url : url?.toString()).toContain("playback=1");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
    const player = panel.querySelector("openclaw-chat-video-player");
    expect(player?.mediaWidth).toBe(9);
    expect(player?.mediaHeight).toBe(16);
    expect(panel.querySelector(":scope > video")).toBeNull();
    panel.remove();
  });

  it("plays normalized base64 audio from Files", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.content = {
      kind: "attachment",
      attachmentKind: "audio",
      title: "inline.wav",
      src: "data:audio/wav;base64,UklGRg==",
      mimeType: "audio/wav",
    };
    container.append(panel);
    await panel.updateComplete;

    const player = panel.querySelector("openclaw-chat-audio-player");
    expect(player?.src).toBe("data:audio/wav;base64,UklGRg==");
    panel.remove();
  });

  it.each([
    ["external.html", "https://files.example/external.html", "text/html"],
    ["external.pdf", "https://files.example/external.pdf", "application/pdf"],
  ] as const)(
    "renders document %s as a Files card without previewing it",
    async (title, src, mimeType) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
      panel.content = {
        kind: "attachment",
        attachmentKind: "document",
        title,
        src,
        mimeType,
      };
      container.append(panel);
      await panel.updateComplete;

      expect(panel.querySelector("iframe, table, audio, video")).toBeNull();
      expect(panel.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull();
      const download = panel.querySelector<HTMLAnchorElement>(
        ".chat-assistant-attachment-card__download",
      );
      expect(download?.getAttribute("href")).toBe(src);
      expect(download?.target).toBe("_blank");
      expect(download?.rel).toBe("noreferrer");
      expect(fetchMock).not.toHaveBeenCalled();
      panel.remove();
    },
  );

  it.each(["error"] as const)(
    "keeps the image placeholder through metadata until the image emits %s",
    async (outcome) => {
      let pending = true;
      let src = "/diagram.png";
      const content = {
        kind: "attachment",
        attachmentKind: "image",
        title: "diagram.png",
        mimeType: "image/png",
        width: 600,
        height: 400,
        resolveSource: () => (pending ? { status: "pending" } : { status: "ready", src }),
      } satisfies SidebarContent;
      const panel = Object.assign(document.createElement("openclaw-chat-detail-panel"), {
        content,
      });
      container.append(panel);
      await vi.waitFor(() => expect(panel.querySelector('[role="status"]')).not.toBeNull());
      const presentation = panel.querySelector('[role="status"]');
      const header = panel.querySelector(".chat-assistant-attachment-card__header");
      pending = false;
      panel.content = { ...panel.content };
      const image = await vi.waitFor(() =>
        expectDefined(panel.querySelector(".sidebar-attachment-preview__image"), "Preview image"),
      );
      expect(panel.querySelector('[role="status"]')).toBe(presentation);
      expect(panel.querySelector(".chat-assistant-attachment-card__header")).toBe(header);
      image.dispatchEvent(new Event(outcome));
      expect(image.getAttribute("data-preview")).toBe("error");
      src = "/next.png";
      panel.content = { ...panel.content };
      const next = await vi.waitFor(() => {
        const current = expectDefined(
          panel.querySelector(".sidebar-attachment-preview__image"),
          "Next preview image",
        );
        expect(current).not.toBe(image);
        return current;
      });
      image.dispatchEvent(new Event("load"));
      expect(next.hasAttribute("data-preview")).toBe(false);
      panel.remove();
      next.dispatchEvent(new Event("load"));
      container.append(panel);
      expect(next.getAttribute("data-preview")).toBe("ready");
      panel.remove();
    },
  );

  it.each([
    { title: "vector.svg", mimeType: "image/svg+xml", src: "https://cdn.example/vector.svg" },
    { title: "diagram", mimeType: undefined, src: "https://cdn.example/vector.svg" },
    {
      title: "vector.svg",
      mimeType: "application/octet-stream",
      src: "https://cdn.example/download/opaque",
    },
  ])(
    "keeps external SVG attachments as Files cards with title $title and MIME $mimeType",
    async ({ title, mimeType, src }) => {
      const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
      panel.content = {
        kind: "attachment",
        attachmentKind: "image",
        title,
        src,
        mimeType,
      };
      container.append(panel);
      await panel.updateComplete;

      expect(panel.querySelector(".sidebar-attachment-preview__image")).toBeNull();
      expect(
        panel
          .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")
          ?.getAttribute("href"),
      ).toBe(src);
      panel.remove();
    },
  );

  it("keeps a canvas scripts ceiling under a trusted global sandbox", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.embedSandboxMode = "trusted";
    panel.canvasPluginSurfaceUrl = "https://canvas.example";
    const content = {
      kind: "canvas",
      docId: "preview-1",
      title: "Preview",
      entryUrl: "https://canvas.example/previews/preview-1",
      sandbox: "scripts",
    } satisfies SidebarContent;
    panel.content = content;
    container.append(panel);
    await panel.updateComplete;

    const frame = panel.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");

    panel.content = { ...content, title: "Renamed preview" };
    await panel.updateComplete;
    expect(panel.querySelector("iframe")).toBe(frame);
    expect(frame?.title).toBe("Renamed preview");

    panel.content = { ...content, sandbox: "strict" };
    await panel.updateComplete;
    expect(panel.querySelector("iframe")).not.toBe(frame);
    expect(panel.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    panel.remove();
  });
});

describe("file sidebar clipboard feedback", () => {
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

  type FilePanel = HTMLElement & {
    content: unknown;
    updateComplete: Promise<unknown>;
  };

  async function mountFilePanel(): Promise<FilePanel> {
    const panel = document.createElement("openclaw-chat-detail-panel") as FilePanel;
    panel.content = {
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      content: "const answer = 42;",
    };
    container.append(panel);
    await panel.updateComplete;
    return panel;
  }

  function findCopyButton(panel: FilePanel, label: string): HTMLButtonElement {
    const button = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );
    if (!button) {
      throw new Error(`Missing sidebar button: ${label}`);
    }
    return button;
  }

  function denyClipboard() {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    return { execCommand, writeText };
  }

  function captureFeedbackTimers() {
    const schedule = vi.spyOn(globalThis, "setTimeout");
    return {
      schedule,
      run(delay: number, index = 0) {
        const timerIndex = schedule.mock.calls
          .map(([, timeout], callIndex) => (timeout === delay ? callIndex : -1))
          .filter((callIndex) => callIndex >= 0)[index];
        if (timerIndex === undefined) {
          throw new Error(`Missing sidebar clipboard reset timer after ${delay}ms`);
        }
        const reset = schedule.mock.calls[timerIndex]?.[0];
        if (typeof reset !== "function") {
          throw new Error(`Expected sidebar clipboard reset timer after ${delay}ms`);
        }
        globalThis.clearTimeout(schedule.mock.results[timerIndex]?.value);
        reset();
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalExecCommand) {
      Object.defineProperty(document, "execCommand", originalExecCommand);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
    document.body.replaceChildren();
  });

  it("ignores an older successful path copy after a failed retry", async () => {
    const label = "Copy path";
    const { writeText } = denyClipboard();
    let finishFirstCopy = () => {};
    writeText.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishFirstCopy = resolve;
      }),
    );
    const panel = await mountFilePanel();
    const button = findCopyButton(panel, label);

    button.click();
    button.click();
    await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copy failed"));
    finishFirstCopy();
    await Promise.resolve();
    await Promise.resolve();
    await panel.updateComplete;

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Copy failed");
  });

  it("keeps path and contents feedback reset timers independent", async () => {
    denyClipboard();
    const panel = await mountFilePanel();
    const pathButton = findCopyButton(panel, "Copy path");
    const contentsButton = findCopyButton(panel, "Copy file contents");
    const timers = captureFeedbackTimers();

    pathButton.click();
    contentsButton.click();
    await vi.waitFor(() => {
      expect(pathButton.getAttribute("aria-label")).toBe("Copy failed");
      expect(contentsButton.getAttribute("aria-label")).toBe("Copy failed");
    });

    timers.run(2_000);
    await panel.updateComplete;
    expect(pathButton.getAttribute("aria-label")).toBe("Copy path");
    expect(contentsButton.getAttribute("aria-label")).toBe("Copy failed");
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Copy failed");

    timers.run(2_000, 1);
    await panel.updateComplete;
    expect(contentsButton.getAttribute("aria-label")).toBe("Copy file contents");
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["file selection", "disconnection"])(
    "ignores a delayed successful copy after %s changes its owner",
    async (change) => {
      let finishCopy = () => {};
      const writeText = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCopy = resolve;
          }),
      );
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, "Copy file contents");
      const timers = captureFeedbackTimers();

      button.click();
      if (change === "file selection") {
        panel.content = {
          kind: "file",
          path: "src/next.ts",
          name: "next.ts",
          content: "const next = true;",
        };
        await panel.updateComplete;
      } else {
        panel.remove();
      }
      finishCopy();
      await Promise.resolve();
      await Promise.resolve();
      await panel.updateComplete;

      expect(timers.schedule.mock.calls.some(([, delay]) => delay === 1_500)).toBe(false);
      expect(button.getAttribute("aria-label")).toBe("Copy file contents");
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("restores idle contents feedback when the same sidebar reconnects", async () => {
    const label = "Copy file contents";
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const panel = await mountFilePanel();
    const button = findCopyButton(panel, label);

    button.click();
    await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copied!"));

    panel.remove();
    // Let the bridge retire the disconnected root before reconnecting this host.
    await Promise.resolve();
    container.append(panel);
    await panel.updateComplete;

    expect(findCopyButton(panel, label).classList.contains("copied")).toBe(false);
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores an older contents copy after sidebar reconnection", async () => {
    const label = "Copy file contents";
    let finishCopy = () => {};
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        }),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const panel = await mountFilePanel();
    const button = findCopyButton(panel, label);
    const timers = captureFeedbackTimers();

    button.click();
    panel.remove();
    await Promise.resolve();
    container.append(panel);
    await panel.updateComplete;
    finishCopy();
    await Promise.resolve();
    await Promise.resolve();
    await panel.updateComplete;

    expect(findCopyButton(panel, label).getAttribute("aria-label")).toBe(label);
    expect(timers.schedule.mock.calls.some(([, delay]) => delay === 1_500)).toBe(false);
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });
});
