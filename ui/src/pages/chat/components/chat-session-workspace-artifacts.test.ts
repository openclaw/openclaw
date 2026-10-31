import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import * as toast from "../../../lib/toast.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import {
  clearSessionWorkspacePreviews,
  selectSessionWorkspacePreview,
  sessionWorkspaceForHost,
} from "./chat-session-workspace-state.ts";
import { createSidebarContentRecorder } from "./chat-session-workspace.test-support.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceManagedArtifact,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { SidebarContent, SidebarSelection } from "./chat-sidebar-content-types.ts";

const httpOptions = {
  credentials: "same-origin",
  redirect: "error",
  signal: expect.any(AbortSignal),
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
    {
      title = "Unicode artifact",
      http = false,
      id = "artifact-1",
    }: { title?: string; http?: boolean; id?: string } = {},
  ) {
    const settled = createDeferred<Exclude<SidebarSelection, { kind: "loading" }>>();
    const url = "/api/artifacts/download/connection/ticket";
    const artifact = {
      id,
      type: mimeType.startsWith("image/") ? "image" : "file",
      mimeType,
      title,
      sizeBytes: atob(data).length,
      download: { mode: http ? ("url" as const) : ("bytes" as const) },
    };
    const request = vi.fn(async (method: string, query: { transport?: string }) =>
      method === "artifacts.list"
        ? { artifacts: [artifact] }
        : {
            artifact,
            ...(http && query.transport === "http" ? { url } : { data, encoding: "base64" }),
          },
    );
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

  async function createBinaryArtifact() {
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
    if (content.kind !== "attachment" || !content.download || !content.file) {
      throw new Error("Binary artifact must expose a download action");
    }
    return { ...fixture, props, file: content.file };
  }

  const managedId = "artifact_managed_media_12345678-1234-4234-8234-123456789abc";
  const managedHref =
    "/api/chat/media/outgoing/agent%3Amain%3Acurrent/12345678-1234-4234-8234-123456789abc/full";

  it("tells an offline reader to reconnect and retry without requesting artifacts", () => {
    const fixture = createArtifactHost("application/json", "", { id: managedId });
    fixture.state.connected = false;
    const show = vi.spyOn(toast, "showToast").mockReturnValue(true);
    openSessionWorkspaceManagedArtifact(fixture.state, managedHref);
    expect(show).toHaveBeenCalledWith({
      message: "You're offline. Reconnect, then open this attachment link again.",
      severity: "error",
    });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("reuses the original artifact tab when a later link selects the same saved file", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const fixture = createArtifactHost("application/json", btoa('{"original":true}'), {
      id: managedId,
    });
    createSessionWorkspaceProps(fixture.state).onOpenArtifact(managedId);
    await fixture.loadedContent();
    const original = fixture.state.sessionWorkspaceState!.previews[0]!;
    openSessionWorkspaceManagedArtifact(fixture.state, managedHref);
    const linked = fixture.state.sessionWorkspaceState!.previews.at(-1)!;
    await linked.readResult;
    expect(fixture.state.sessionWorkspaceState!.previews).toEqual([original]);
    expect(original.content).toMatchObject({ kind: "file", content: '{"original":true}' });
  });

  it.each(["missing", "foreign", "malformed", "denied"])(
    "keeps a %s managed reference unavailable without selecting other bytes",
    async (condition) => {
      const fixture = createArtifactHost("application/json", btoa('{"original":true}'), {
        id: condition === "missing" ? "artifact-1" : managedId,
      });
      if (condition === "denied") {
        fixture.request.mockRejectedValueOnce(new Error("Access denied"));
      }
      const href =
        condition === "foreign"
          ? managedHref.replace("current", "other")
          : condition === "malformed"
            ? managedHref.replace("/full", "/invalid")
            : managedHref;
      expect(openSessionWorkspaceManagedArtifact(fixture.state, href)).toBe(true);
      const preview = fixture.state.sessionWorkspaceState!.previews[0]!;
      await preview.readResult;
      expect(preview.content).toMatchObject({
        kind: "unavailable",
        message:
          condition === "denied"
            ? "Access denied"
            : "This attachment is unavailable in this chat. Ask the sender to share it again.",
      });
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "artifacts.download"),
      ).toEqual([]);
      expect(
        openSessionWorkspaceManagedArtifact(fixture.state, `https://other.test${managedHref}`),
      ).toBe(false);
    },
  );

  it.each(["close", "connection"])(
    "does not open a managed reference after %s retires its metadata read",
    async (retirement) => {
      const fixture = createArtifactHost("application/json", btoa('{"original":true}'), {
        id: managedId,
      });
      fixture.state.connectionEpoch = 1;
      const metadata = createDeferred();
      const started = createDeferred();
      fixture.request.mockImplementationOnce(async () => {
        started.resolve();
        await metadata.promise;
        return { artifacts: [fixture.artifact] };
      });
      openSessionWorkspaceManagedArtifact(fixture.state, managedHref);
      const preview = fixture.state.sessionWorkspaceState!.previews[0]!;
      await started.promise;
      if (retirement === "close") {
        clearSessionWorkspacePreviews(fixture.state);
      } else {
        fixture.state.connectionEpoch += 1;
        createSessionWorkspaceProps(fixture.state);
      }
      metadata.resolve();
      await preview.readResult;
      expect(fixture.state.sessionWorkspaceState!.previews).toEqual([]);
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "artifacts.download"),
      ).toEqual([]);
    },
  );

  it.each([false, true])(
    "reauthorizes an expired cached binary download and saves its bytes (HTTP fails: %s)",
    async (httpFails) => {
      const fixture = await createBinaryArtifact();
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
      const downloaded = await fixture.file.download(new AbortController().signal);
      if (!downloaded || !("blob" in downloaded)) {
        throw new Error("Missing binary artifact bytes");
      }
      expect(new Uint8Array(await downloaded.blob.arrayBuffer())).toEqual(bytes);
      expect(downloaded.filename).toBe("archive.zip");
      expect(fixture.fetchMock).toHaveBeenCalledExactlyOnceWith(
        "/mount/api/artifacts/download/connection/ticket-2",
        httpOptions,
      );
    },
  );

  it.each([
    ["close", "image/png", "image"],
    ["background", "image/png", "image"],
    ["close", "text/csv", "file"],
    ["background", "text/csv", "file"],
  ] as const)(
    "retires a managed transfer when its tab is %s (%s)",
    async (retirement, mimeType, contentKind) => {
      if (contentKind === "file") {
        vi.stubGlobal("Blob", NodeBlob);
      }
      const fixture = createArtifactHost(mimeType, "", { http: true });
      const source = "/api/chat/media/outgoing/agent%3Amain%3Acurrent/lifecycle/full";
      fixture.request.mockResolvedValue({
        artifact: {
          ...fixture.artifact,
          id: `managed-${retirement}-${contentKind}`,
          sizeBytes: 11,
        },
        url: `${source}?mediaTicket=fixture`,
      });
      vi.stubGlobal(
        "URL",
        Object.assign(class extends URL {}, {
          createObjectURL: vi.fn(() => `blob:managed-${retirement}`),
          revokeObjectURL: vi.fn(),
        }),
      );
      const started = createDeferred<AbortSignal>();
      const transfer = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: unknown, options: { signal: AbortSignal }) => {
          started.resolve(options.signal);
          return transfer.promise;
        }),
      );
      createSessionWorkspaceProps(fixture.state).onOpenArtifact("artifact-1");
      const signal = await started.promise;
      const preview = fixture.state.sessionWorkspaceState!.previews[0]!;
      if (retirement === "close") {
        clearSessionWorkspacePreviews(fixture.state);
      } else {
        selectSessionWorkspacePreview(fixture.state, null);
      }
      const aborted = signal.aborted;
      // A transport can finish despite cancellation; closed tabs must not return.
      transfer.resolve(
        contentKind === "file"
          ? new Response("file,bytes\n", { headers: { "Content-Type": mimeType } })
          : ({
              ok: true,
              blob: async () => new Blob(["image bytes"], { type: mimeType }),
            } as Response),
      );
      await preview.readResult;
      expect(aborted).toBe(retirement === "close");
      const workspace = fixture.state.sessionWorkspaceState!;
      expect(workspace.activePreviewId).toBeNull();
      if (retirement === "close") {
        expect(workspace.previews).toEqual([]);
      } else {
        expect(workspace.previews).toEqual([preview]);
        expect(preview.content.kind).toBe(contentKind);
      }
    },
  );

  it("keeps unsupported managed images downloadable without fetching a preview", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const fixture = createArtifactHost("image/heic", "", { title: "photo.heic", http: true });
    fixture.request.mockResolvedValue({
      artifact: fixture.artifact,
      url: "/api/chat/media/outgoing/agent%3Amain%3Acurrent/heic/full?mediaTicket=fixture",
    });
    const bytes = new Uint8Array([0, 1, 2, 3]);
    fixture.fetchMock.mockResolvedValue(new Response(bytes));
    createSessionWorkspaceProps(fixture.state).onOpenArtifact("artifact-1");
    const content = await fixture.loadedContent();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    expect(content.kind).toBe("attachment");
    if (content.kind !== "attachment" || !content.file) {
      throw new Error("Missing original download");
    }
    const downloaded = await content.file.download(new AbortController().signal);
    if (!downloaded || !("blob" in downloaded)) {
      throw new Error("Missing original bytes");
    }
    expect(new Uint8Array(await downloaded.blob.arrayBuffer())).toEqual(bytes);
  });

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
    ["text/plain; charset=utf-8", "Résumé 東京 🦀", true, undefined, ""],
    ["application/json", JSON.stringify("Résumé 東京 🦀"), false, "Report", "json"],
    ["image/png", "iVBORw0KGgo=", true, "preview.png", undefined],
    ["text/html", "<h1>Actual artifact</h1>", true, "report.html", undefined],
    ["image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>', false, "preview.svg", ""],
  ] as const)("previews %s source %s", async (mimeType, source, http, title, language) => {
    const image = mimeType === "image/png";
    const proxy = mimeType === "text/html";
    const data = image ? source : btoa(String.fromCharCode(...new TextEncoder().encode(source)));
    const { state, fetchMock, url, loadedContent } = createArtifactHost(mimeType, data, {
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
      expect(content).toMatchObject({
        kind: "image",
        mimeType: "image/png",
        src: `data:image/png;base64,${data}`,
        title: "preview.png",
        file: { artifactId: "artifact-1", download: expect.any(Function) },
      });
    } else if (proxy) {
      expect(content).toMatchObject({ kind: "file", name: "report.html", rawText: source });
    } else {
      expect(content).toMatchObject({
        kind: "file",
        name: title ?? "Unicode artifact",
        content: source,
        rawText: source,
        mimeType,
        language,
      });
    }
    if (http) {
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, httpOptions);
    }
  });
});
