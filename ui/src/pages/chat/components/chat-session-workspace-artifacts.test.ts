import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  gatewayHello,
  loadedSidebarContent,
  createSidebarContentRecorder,
} from "./chat-session-workspace.test-support.ts";
import {
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { AttachmentSidebarRuntime, SidebarContent } from "./chat-sidebar-content-types.ts";

describe("session workspace artifacts", () => {
  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createArtifactHost(params: {
    data: string;
    mimeType: string;
    title?: string;
    http?: boolean;
  }) {
    const handleOpenSidebar = createSidebarContentRecorder();
    const url = "/api/artifacts/download/connection/ticket";
    const request = vi.fn(async (_method: string, query: { transport?: string }) => ({
      artifact: {
        id: "artifact-1",
        mimeType: params.mimeType,
        title: params.title ?? "Unicode artifact",
      },
      ...(params.http && query.transport === "http"
        ? { url }
        : { data: params.data, encoding: "base64" }),
    }));
    const fetchMock = vi.fn(async () => {
      const bytes = Uint8Array.from(atob(params.data), (char) => char.charCodeAt(0));
      return {
        ok: true,
        headers: new Headers({ "Content-Disposition": 'attachment; filename="artifact"' }),
        blob: async () =>
          params.mimeType.startsWith("image/")
            ? new Blob([bytes], { type: params.mimeType })
            : {
                type: params.mimeType.split(";", 1)[0]?.toLowerCase(),
                text: async () => new TextDecoder().decode(bytes),
              },
      };
    });
    if (params.http) {
      vi.stubGlobal("location", new URL("https://control.test"));
      vi.stubGlobal("fetch", fetchMock);
    }
    const state = {
      client: { request, gatewayUrl: "wss://control.test" },
      connected: true,
      resourceBasePath: "/mount",
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: {},
    } as unknown as SessionWorkspaceHost;
    return { handleOpenSidebar, request, state, fetchMock, url: `/mount${url}` };
  }

  async function createBinaryArtifactPanel() {
    // jsdom's Blob lacks arrayBuffer; binary download tests need the native byte contract.
    vi.stubGlobal("Blob", NodeBlob);
    const fixture = createArtifactHost({
      data: "UEsAAQ==",
      mimeType: "application/zip",
      title: "archive.zip",
      http: true,
    });
    fixture.state.connectionEpoch = 1;
    const artifact = {
      id: "artifact-1",
      type: "file",
      title: "archive.zip",
      mimeType: "application/zip",
      download: { mode: "url" },
    };
    let ticket = 0;
    fixture.request.mockImplementation(async (_method, params) => ({
      artifact,
      ...(params.transport === "http"
        ? {
            url: `/api/artifacts/download/connection/ticket-${++ticket}`,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }
        : { encoding: "base64", data: "UEsAAQ==" }),
    }));
    const props = createSessionWorkspaceProps(fixture.state);
    props.onOpenArtifact("artifact-1");
    const content = await loadedSidebarContent(fixture.state);
    if (content.kind !== "attachment" || !content.download) {
      throw new Error("Binary artifact must expose a download action");
    }
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: SidebarContent;
      attachmentRuntime: AttachmentSidebarRuntime;
      updateComplete: Promise<unknown>;
    };
    panel.content = content;
    panel.attachmentRuntime = { connectionEpoch: 1, sessionKey: fixture.state.sessionKey };
    document.body.append(panel);
    onTestFinished(() => panel.remove());
    await panel.updateComplete;
    const button = panel.querySelector<HTMLButtonElement>(
      "button.chat-assistant-attachment-card__download",
    );
    if (!button) {
      throw new Error("Binary artifact must render the attachment download action");
    }
    const saved = createDeferred<Blob>();
    const NativeURL = URL;
    const createObjectURL = vi.fn((blob: Blob) => {
      saved.resolve(blob);
      return "blob:artifact-download";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeURL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        clicked.push(this);
      },
    );
    return {
      ...fixture,
      artifact,
      props,
      content,
      panel,
      button,
      saved,
      createObjectURL,
      revokeObjectURL,
      clicked,
    };
  }

  it.each([false, true])(
    "reauthorizes an expired cached binary download and saves its bytes (HTTP fails: %s)",
    async (httpFails) => {
      const fixture = await createBinaryArtifactPanel();
      expect(fixture.fetchMock).not.toHaveBeenCalled();
      const bytes = new Uint8Array([80, 75, 0, 1]);
      const blob = new Blob([bytes], { type: "application/zip" });
      fixture.fetchMock.mockImplementation(async () => {
        if (httpFails) {
          throw new TypeError("HTTP media is unreachable");
        }
        return {
          ok: true,
          headers: new Headers({ "Content-Disposition": 'attachment; filename="archive.zip"' }),
          blob: async () => blob,
        };
      });
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 360_000);
      fixture.props.onOpenArtifact("artifact-1");
      expect(fixture.request).toHaveBeenCalledTimes(1);
      fixture.button.click();
      const downloaded = await fixture.saved.promise;
      const actualBytes = new Uint8Array(await downloaded.arrayBuffer());
      expect(actualBytes).toEqual(bytes);
      expect(fixture.clicked[0]?.download).toBe("archive.zip");
      expect(fixture.fetchMock).toHaveBeenCalledExactlyOnceWith(
        "/mount/api/artifacts/download/connection/ticket-2",
        {
          credentials: "same-origin",
          redirect: "error",
          signal: expect.any(AbortSignal),
        },
      );
      expect(fixture.request.mock.calls.map(([, params]) => params)).toEqual([
        {
          sessionKey: fixture.state.sessionKey,
          agentId: "main",
          artifactId: "artifact-1",
          transport: "http",
        },
        {
          sessionKey: fixture.state.sessionKey,
          agentId: "main",
          artifactId: "artifact-1",
          transport: "http",
        },
        ...(httpFails
          ? [{ sessionKey: fixture.state.sessionKey, agentId: "main", artifactId: "artifact-1" }]
          : []),
      ]);
      vi.runOnlyPendingTimers();
      expect(fixture.revokeObjectURL).toHaveBeenCalledWith("blob:artifact-download");
    },
  );

  it.each(["reconnect", "panel removal"])(
    "does not save a binary download after %s",
    async (retirement) => {
      const fixture = await createBinaryArtifactPanel();
      const transfer = createDeferred<{
        ok: boolean;
        headers: Headers;
        blob: () => Promise<Blob>;
      }>();
      const started = createDeferred();
      fixture.fetchMock.mockImplementation(() => {
        started.resolve();
        return transfer.promise;
      });
      const read = vi.spyOn(fixture.content, "download");
      fixture.button.click();
      await started.promise;
      if (retirement === "reconnect") {
        fixture.state.connectionEpoch = 2;
        fixture.state.client = { request: vi.fn(), gatewayUrl: "wss://control.test" } as never;
        fixture.panel.attachmentRuntime = {
          connectionEpoch: 2,
          sessionKey: fixture.state.sessionKey,
        };
        await fixture.panel.updateComplete;
      } else {
        fixture.panel.remove();
      }
      transfer.resolve({
        ok: true,
        headers: new Headers({ "Content-Disposition": 'attachment; filename="archive.zip"' }),
        blob: async () => new Blob(["old"], { type: "application/zip" }),
      });
      await read.mock.results[0]?.value;
      await fixture.panel.updateComplete;
      expect(fixture.createObjectURL).not.toHaveBeenCalled();
      expect(fixture.request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([true, false])(
    "uses artifact titles without changing tab identity (listed: %s)",
    async (listed) => {
      const { state, request } = createArtifactHost({
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
        title: "resolved-image.png",
      });
      const props = createSessionWorkspaceProps(state);
      const workspace = state.sessionWorkspaceState!;
      if (listed) {
        workspace.list = {
          sessionKey: state.sessionKey,
          files: [],
          artifacts: [
            {
              id: "artifact-1",
              title: "listed-image.png",
              type: "image",
              mimeType: "image/png",
              download: { mode: "bytes" },
            },
          ],
        };
      }
      props.onOpenArtifact("artifact-1");
      const preview = workspace.previews[0]!;
      expect(preview.label).toBe(listed ? "listed-image.png" : "Artifacts");
      await loadedSidebarContent(state);
      expect(preview.label).toBe("resolved-image.png");
      props.onOpenArtifact("artifact-1");
      expect(workspace.previews).toEqual([preview]);
      expect(preview.id).toBe("artifact:artifact-1");
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("keeps nested code literal in a decoded text artifact preview", async () => {
    const source = [
      "Résumé 東京 🦀",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "**literal after**",
    ].join("\n");
    const { state } = createArtifactHost({
      data: btoa(String.fromCharCode(...new TextEncoder().encode(source))),
      mimeType: "text/markdown",
      title: "Source notes",
    });
    createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");
    const content = await loadedSidebarContent(state);
    expect(content).toMatchObject({ kind: "markdown", rawText: source });
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: SidebarContent;
      updateComplete: Promise<unknown>;
    };
    panel.content = content;
    document.body.append(panel);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      await panel.updateComplete;
      const reader = panel.querySelector(".sidebar-markdown-reader");
      expect(reader?.querySelector("h1")?.textContent).toBe("Source notes");
      expect.soft(reader?.querySelectorAll("pre code")).toHaveLength(1);
      expect.soft(reader?.querySelector("pre code")?.textContent).toBe(`${source}\n`);
      expect.soft(reader?.querySelector("strong")).toBeNull();
      const copyButton = reader?.querySelector<HTMLButtonElement>(".code-block-copy");
      expect(copyButton).toBeInstanceOf(HTMLButtonElement);
      copyButton!.click();
      await vi.waitFor(() => expect(copyButton!.getAttribute("aria-label")).toBe("Copied!"));
      expect(writeText).toHaveBeenCalledWith(source);
    } finally {
      for (const [index, [, delay]] of schedule.mock.calls.entries()) {
        if (delay === 1_500) {
          globalThis.clearTimeout(schedule.mock.results[index]?.value);
        }
      }
      schedule.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      panel.remove();
    }
  });

  it.each(
    [
      {
        content: "Résumé 東京 🦀",
        fence: "```",
        mimeType: "text/plain",
      },
      {
        content: "Résumé 東京 🦀",
        fence: "```",
        mimeType: "text/plain; charset=utf-8",
      },
      {
        content: JSON.stringify({ message: "Résumé 東京 🦀" }),
        fence: "```json",
        mimeType: "application/json",
      },
    ].flatMap((testCase) => [false, true].map((http) => Object.assign({ http }, testCase))),
  )(
    "decodes UTF-8 $mimeType artifacts without corrupting visible or raw text (HTTP: $http)",
    async (testCase) => {
      const data = btoa(String.fromCharCode(...new TextEncoder().encode(testCase.content)));
      const { state, fetchMock, url } = createArtifactHost({
        data,
        mimeType: testCase.mimeType,
        http: testCase.http,
      });

      createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

      expect(await loadedSidebarContent(state)).toEqual({
        kind: "markdown",
        content: `# Unicode artifact\n\n${testCase.fence}\n${testCase.content}\n\`\`\``,
        rawText: testCase.content,
      });
      if (testCase.http) {
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
          credentials: "same-origin",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      }
    },
  );

  it.each([false, true])(
    "retains image artifact previews beyond ticket expiry (HTTP: %s)",
    async (http) => {
      const data = "iVBORw0KGgo=";
      const { state, fetchMock, url } = createArtifactHost({
        data,
        mimeType: "image/png",
        title: "preview.png",
        http,
      });

      createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

      expect(await loadedSidebarContent(state)).toEqual({
        kind: "image",
        mimeType: "image/png",
        rawText: http ? url : null,
        src: `data:image/png;base64,${data}`,
        title: "preview.png",
      });
      if (http) {
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
          credentials: "same-origin",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      }
    },
  );

  it.each([undefined, 'inline; filename="index.html"'])(
    "reauthorizes HTML artifact bytes when the proxy returns application HTML with disposition %s",
    async (disposition) => {
      const source = "<h1>Actual artifact</h1>";
      const { state, request, fetchMock, url } = createArtifactHost({
        data: btoa(source),
        mimeType: "text/html",
        title: "report.html",
        http: true,
      });
      fetchMock.mockResolvedValueOnce(
        new Response("<html><body>Control UI application</body></html>", {
          headers: {
            "Content-Type": "text/html",
            ...(disposition ? { "Content-Disposition": disposition } : {}),
          },
        }),
      );

      createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

      expect(await loadedSidebarContent(state)).toMatchObject({
        kind: "markdown",
        rawText: source,
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
        credentials: "same-origin",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
      expect(request.mock.contexts).toEqual([state.client, state.client]);
      expect(request.mock.calls.map(([, query]) => query)).toEqual([
        {
          sessionKey: state.sessionKey,
          agentId: "main",
          artifactId: "artifact-1",
          transport: "http",
        },
        { sessionKey: state.sessionKey, agentId: "main", artifactId: "artifact-1" },
      ]);
    },
  );

  it("reports malformed base64 artifact data as a visible workspace error", async () => {
    const { handleOpenSidebar, state } = createArtifactHost({
      data: "not-base64!",
      mimeType: "text/plain",
    });

    createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).error).toMatch(/InvalidCharacterError|invalid/i),
    );
    expect(handleOpenSidebar).toHaveBeenCalledOnce();
    expect(state.sessionWorkspaceState?.previews.at(-1)?.content).toMatchObject({
      kind: "unavailable",
    });
  });
});
