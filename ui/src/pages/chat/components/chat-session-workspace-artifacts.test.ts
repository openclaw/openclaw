import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import "./chat-detail-panel.tsx";
import { sessionWorkspaceForHost } from "./chat-session-workspace-state.ts";
import { createSidebarContentRecorder } from "./chat-session-workspace.test-support.ts";
import {
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { SidebarContent, SidebarSelection } from "./chat-sidebar-content-types.ts";

const httpOptions = {
  credentials: "same-origin",
  redirect: "error",
  signal: expect.any(AbortSignal),
};
const artifactQuery = {
  sessionKey: "agent:main:current",
  agentId: "main",
  artifactId: "artifact-1",
};

function binaryResponse(blob: Blob) {
  return new Response(blob, {
    headers: { "Content-Disposition": 'attachment; filename="archive.zip"' },
  });
}

describe("session workspace artifacts", () => {
  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createArtifactHost(
    mimeType: string,
    data: string,
    { title = "Unicode artifact", http = false }: { title?: string; http?: boolean } = {},
  ) {
    const settled = createDeferred<Exclude<SidebarSelection, { kind: "loading" }>>();
    const url = "/api/artifacts/download/connection/ticket";
    const artifact = {
      id: "artifact-1",
      type: mimeType.startsWith("image/") ? "image" : "file",
      mimeType,
      title,
      download: { mode: http ? ("url" as const) : ("bytes" as const) },
    };
    const request = vi.fn(async (_method: string, query: { transport?: string }) => ({
      artifact,
      ...(http && query.transport === "http" ? { url } : { data, encoding: "base64" }),
    }));
    const fetchMock = vi.fn(async () => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return {
        ok: true,
        headers: new Headers({ "Content-Disposition": 'attachment; filename="artifact"' }),
        blob: async () =>
          mimeType.startsWith("image/")
            ? new Blob([bytes], { type: mimeType })
            : {
                type: mimeType.split(";", 1)[0]?.toLowerCase(),
                text: async () => new TextDecoder().decode(bytes),
              },
      };
    });
    if (http) {
      vi.stubGlobal("location", new URL("https://control.test"));
      vi.stubGlobal("fetch", fetchMock);
    }
    const state = {
      client: { request, gatewayUrl: "wss://control.test" },
      connected: true,
      resourceBasePath: "/mount",
      handleOpenSidebar: createSidebarContentRecorder(),
      hello: gatewayHelloForMethods([]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: {},
    } as unknown as SessionWorkspaceHost;
    onTestFinished(
      sessionWorkspaceForHost(state).subscribe(() => {
        const content = state.sessionWorkspaceState?.previews.find(
          (entry) => entry.id === state.sessionWorkspaceState?.activePreviewId,
        )?.content;
        if (content && content.kind !== "loading") {
          settled.resolve(content);
        }
      }),
    );
    const loadedContent = async (): Promise<SidebarContent> => {
      const content = await settled.promise;
      if (content.kind === "unavailable") {
        throw new Error(content.message);
      }
      return content;
    };
    return { artifact, request, state, fetchMock, url: `/mount${url}`, loadedContent };
  }

  async function createBinaryArtifactPanel() {
    // jsdom's Blob lacks arrayBuffer; binary download tests need the native byte contract.
    vi.stubGlobal("Blob", NodeBlob);
    const fixture = createArtifactHost("application/zip", "UEsAAQ==", {
      title: "archive.zip",
      http: true,
    });
    fixture.state.connectionEpoch = 1;
    let ticket = 0;
    fixture.request.mockImplementation(async (_method, params) => ({
      artifact: fixture.artifact,
      ...(params.transport === "http"
        ? {
            url: `/api/artifacts/download/connection/ticket-${++ticket}`,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }
        : { encoding: "base64", data: "UEsAAQ==" }),
    }));
    const props = createSessionWorkspaceProps(fixture.state);
    props.onOpenArtifact("artifact-1");
    const content = await fixture.loadedContent();
    if (content.kind !== "attachment" || !content.download) {
      throw new Error("Binary artifact must expose a download action");
    }
    const panel = document.createElement("openclaw-chat-detail-panel");
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
    const urls = {
      createObjectURL: vi.fn((blob: Blob) => {
        saved.resolve(blob);
        return "blob:artifact-download";
      }),
      revokeObjectURL: vi.fn(),
    };
    vi.stubGlobal("URL", Object.assign(class extends URL {}, urls));
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    return { ...fixture, props, content, panel, button, saved, urls, clicked };
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
        return binaryResponse(blob);
      });
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 360_000);
      fixture.props.onOpenArtifact("artifact-1");
      expect(fixture.request).toHaveBeenCalledTimes(1);
      fixture.button.click();
      const downloaded = await fixture.saved.promise;
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
      expect(fixture.clicked[0]?.download).toBe("archive.zip");
      expect(fixture.fetchMock).toHaveBeenCalledExactlyOnceWith(
        "/mount/api/artifacts/download/connection/ticket-2",
        httpOptions,
      );
      expect(fixture.request.mock.calls.map(([, params]) => params)).toEqual([
        { ...artifactQuery, transport: "http" },
        { ...artifactQuery, transport: "http" },
        ...(httpFails ? [artifactQuery] : []),
      ]);
      vi.runOnlyPendingTimers();
      expect(fixture.urls.revokeObjectURL).toHaveBeenCalledWith("blob:artifact-download");
    },
  );

  it.each(["reconnect", "panel removal"])(
    "does not save a binary download after %s",
    async (retirement) => {
      const fixture = await createBinaryArtifactPanel();
      const transfer = createDeferred<Response>();
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
      transfer.resolve(binaryResponse(new Blob(["old"], { type: "application/zip" })));
      await read.mock.results[0]?.value;
      await fixture.panel.updateComplete;
      expect(fixture.urls.createObjectURL).not.toHaveBeenCalled();
      expect(fixture.request).toHaveBeenCalledTimes(2);
    },
  );

  it("uses listed artifact titles without changing tab identity", async () => {
    const { state, request, loadedContent, artifact } = createArtifactHost(
      "image/png",
      "iVBORw0KGgo=",
      { title: "resolved-image.png" },
    );
    const props = createSessionWorkspaceProps(state);
    const workspace = state.sessionWorkspaceState!;
    workspace.list = {
      sessionKey: state.sessionKey,
      files: [],
      artifacts: [{ ...artifact, title: "listed-image.png" }],
    };
    props.onOpenArtifact("artifact-1");
    const preview = workspace.previews[0]!;
    expect(preview.label).toBe("listed-image.png");
    await loadedContent();
    props.onOpenArtifact("artifact-1");
    expect(workspace.previews).toEqual([preview]);
    expect(preview).toMatchObject({ label: "resolved-image.png", id: "artifact:artifact-1" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["text/plain; charset=utf-8", "Résumé 東京 🦀", true, undefined, "```"],
    ["application/json", JSON.stringify("Résumé 東京 🦀"), false, undefined, "```json"],
    ["image/png", "iVBORw0KGgo=", true, "preview.png", undefined],
    ["text/html", "<h1>Actual artifact</h1>", true, "report.html", undefined],
  ] as const)("previews %s source %s", async (mimeType, source, http, title, fence) => {
    const image = mimeType === "image/png";
    const proxy = mimeType === "text/html";
    const data = image ? source : btoa(String.fromCharCode(...new TextEncoder().encode(source)));
    const { state, request, fetchMock, url, loadedContent } = createArtifactHost(mimeType, data, {
      http,
      title,
    });
    if (proxy) {
      fetchMock.mockResolvedValueOnce(
        new Response("<html><body>Control UI application</body></html>", {
          headers: {
            "Content-Type": "text/html",
            "Content-Disposition": 'inline; filename="index.html"',
          },
        }),
      );
    }
    createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");
    const content = await loadedContent();
    if (image) {
      expect(content).toEqual({
        kind: "image",
        mimeType: "image/png",
        rawText: url,
        src: `data:image/png;base64,${data}`,
        title: "preview.png",
      });
    } else if (proxy) {
      expect(content).toMatchObject({ kind: "markdown", rawText: source });
      expect(request.mock.contexts).toEqual([state.client, state.client]);
      expect(request.mock.calls.map(([, query]) => query)).toEqual([
        { ...artifactQuery, transport: "http" },
        artifactQuery,
      ]);
    } else {
      expect(content).toEqual({
        kind: "markdown",
        content: `# Unicode artifact\n\n${fence}\n${source}\n\`\`\``,
        rawText: source,
      });
    }
    if (http) {
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, httpOptions);
    }
  });
});
