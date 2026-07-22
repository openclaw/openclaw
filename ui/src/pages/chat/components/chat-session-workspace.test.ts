import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  renderSessionWorkspaceRail,
  toggleSessionWorkspace,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

function gatewayHello(methods: string[], scopes = ["operator.admin"], deviceToken?: string) {
  return {
    type: "hello-ok" as const,
    protocol: 3,
    auth: { role: "operator", scopes, ...(deviceToken ? { deviceToken } : {}) },
    features: { methods },
  };
}

describe("toggleSessionWorkspace", () => {
  it("expands and collapses the session workspace rail", () => {
    const requestUpdate = vi.fn();
    const state = {
      client: null,
      connected: false,
      handleOpenSidebar: vi.fn(),
      hello: null,
      requestUpdate,
      sessionKey: "agent:main:current",
      sessions: {},
    } as unknown as SessionWorkspaceHost;

    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);

    toggleSessionWorkspace(state);

    expect(createSessionWorkspaceProps(state).collapsed).toBe(false);

    toggleSessionWorkspace(state);

    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("openSessionWorkspaceFile", () => {
  it("opens Markdown with a canonical Gateway- and pane-scoped draft identity", async () => {
    const handleOpenSidebar = vi.fn();
    const getFile = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:current",
      root: "/workspace",
      file: {
        path: "README.md",
        workspacePath: "README.md",
        name: "README.md",
        kind: "read",
        missing: false,
        content: "# Before\n",
        hash: "a".repeat(64),
      },
    });
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello(["sessions.files.set"]),
      sessionKey: "agent:main:current",
      sessionWorkspaceDraftScope: "pane-left",
      settings: { gatewayUrl: "wss://gateway-a.example" },
      sessions: { getFile },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "readme.md" });

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toMatchObject({
      kind: "file",
      name: "README.md",
      content: "# Before\n",
      draftKey:
        "wss://gateway-a.example\u0000pane-left\u0000agent:main:current\u0000/workspace\u0000README.md",
      edit: { hash: "a".repeat(64) },
    });
  });

  it.each([
    { label: "the method is not advertised", methods: [], scopes: ["operator.admin"] },
    {
      label: "the connection lacks admin scope",
      methods: ["sessions.files.set"],
      scopes: ["operator.read"],
    },
  ])("keeps Markdown read-only when $label", async ({ methods, scopes }) => {
    const handleOpenSidebar = vi.fn();
    const state = {
      client: {},
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello(methods, scopes),
      sessionKey: "agent:main:current",
      sessions: {
        getFile: vi.fn().mockResolvedValue({
          sessionKey: "agent:main:current",
          file: {
            path: "README.md",
            name: "README.md",
            kind: "read",
            missing: false,
            content: "# Before\n",
            hash: "a".repeat(64),
          },
        }),
      },
    } as unknown as SessionWorkspaceHost;

    openSessionWorkspaceFile(state, { path: "README.md" });

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toMatchObject({ kind: "file" });
    expect(handleOpenSidebar.mock.calls[0]?.[0]?.edit).toBeUndefined();
  });

  it.each([
    { root: "/workspace", expected: "/workspace/src/readme.md" },
    { root: "C:\\workspace", expected: "C:\\workspace\\src\\readme.md" },
  ])(
    "opens rendered workspace-browser rows beneath $root with the full path",
    async ({ root, expected }) => {
      const getFile = vi.fn().mockResolvedValue({
        sessionKey: "agent:main:current",
        root,
        file: {
          path: expected,
          workspacePath: "src/readme.md",
          name: "readme.md",
          kind: "read",
          missing: false,
          content: "# Browser file\n",
        },
      });
      const listFiles = vi.fn().mockResolvedValue({
        sessionKey: "agent:main:current",
        root,
        files: [],
        browser: {
          path: "",
          entries: [{ kind: "file", name: "readme.md", path: "src/readme.md" }],
        },
      });
      const request = vi.fn().mockResolvedValue({ artifacts: [] });
      const state = {
        client: { request },
        connected: true,
        handleOpenSidebar: vi.fn(),
        hello: gatewayHello([]),
        sessionKey: "agent:main:current",
        sessions: { getFile, listFiles },
      } as unknown as SessionWorkspaceHost;

      toggleSessionWorkspace(state);
      await vi.waitFor(() => expect(listFiles).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());

      const container = document.createElement("div");
      render(renderSessionWorkspaceRail(createSessionWorkspaceProps(state)), container);
      const row = container.querySelector<HTMLButtonElement>(
        ".chat-workspace-rail__list--browser .chat-workspace-rail__file-open",
      );
      expect(row).toBeInstanceOf(HTMLButtonElement);
      row!.click();

      await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
      expect(getFile.mock.calls[0]?.[1]).toBe(expected);
    },
  );
});

describe("generated image artifacts", () => {
  const managedUrl =
    "/api/chat/media/outgoing/agent%3Amain%3Acurrent/11111111-1111-4111-8111-111111111111/full";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function artifactResult() {
    return {
      artifact: {
        id: "artifact-image",
        type: "image",
        title: "Generated image",
        mimeType: "image/png",
        sessionKey: "agent:main:current",
        messageSeq: 1,
        source: "session-transcript",
        download: { mode: "url" },
      },
      url: managedUrl,
    };
  }

  it("falls back to a shared-secret fetch for URL-returning gateways", async () => {
    const handleOpenSidebar = vi.fn();
    const request = vi.fn().mockResolvedValue(artifactResult());
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer shared-secret-token");
      expect(headers.get("x-openclaw-requester-session-key")).toBe("agent:main:current");
      return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const state = {
      client: { request },
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello(["artifacts.download"], ["operator.read"]),
      settings: { token: "shared-secret-token" },
      sessionKey: "agent:main:current",
      sessions: {},
    } as unknown as SessionWorkspaceHost;

    createSessionWorkspaceProps(state).onOpenArtifact("artifact-image");

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toMatchObject({
      kind: "image",
      src: "data:image/png;base64,cG5n",
      mimeType: "image/png",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      managedUrl,
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("previews admin-resolved managed image bytes without navigating to the protected URL", async () => {
    const handleOpenSidebar = vi.fn();
    const request = vi.fn().mockResolvedValue({
      artifact: {
        ...artifactResult().artifact,
        download: { mode: "bytes" },
      },
      encoding: "base64",
      data: "cG5n",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const state = {
      client: { request },
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello(
        ["artifacts.download"],
        ["operator.read", "operator.admin"],
        "device-token",
      ),
      sessionKey: "agent:main:current",
      sessions: {},
    } as unknown as SessionWorkspaceHost;

    createSessionWorkspaceProps(state).onOpenArtifact("artifact-image");

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    expect(handleOpenSidebar.mock.calls[0]?.[0]).toMatchObject({
      kind: "image",
      src: "data:image/png;base64,cG5n",
      mimeType: "image/png",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows authorization recovery instead of exposing the protected URL", async () => {
    const handleOpenSidebar = vi.fn();
    const request = vi.fn().mockResolvedValue(artifactResult());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch,
    );
    const state = {
      client: { request },
      connected: true,
      handleOpenSidebar,
      hello: gatewayHello(["artifacts.download"], ["operator.read"], "under-scoped-token"),
      sessionKey: "agent:main:current",
      sessions: {},
    } as unknown as SessionWorkspaceHost;

    createSessionWorkspaceProps(state).onOpenArtifact("artifact-image");

    await vi.waitFor(() => expect(handleOpenSidebar).toHaveBeenCalledOnce());
    const content = handleOpenSidebar.mock.calls[0]?.[0];
    expect(content).toMatchObject({ kind: "markdown" });
    expect(content.content).toContain("could not be loaded with the current authorization");
    expect(content.content).not.toContain(managedUrl);
  });
});
