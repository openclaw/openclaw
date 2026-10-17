import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMcpAppView: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  acquireSessionMcpRuntime: vi.fn(),
  releaseLease: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  acquireSessionMcpRuntime: mocks.acquireSessionMcpRuntime,
}));
vi.mock("../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  releaseSessionMcpRuntime: async (lease: { releaseLease: () => void }) => lease.releaseLease(),
}));
vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));
vi.mock("../agents/mcp-ui-resource.js", () => ({
  fetchMcpAppView: mocks.fetchMcpAppView,
  getMcpAppViewLease: mocks.getMcpAppViewLease,
}));
vi.mock("./session-transcript-readers.js", () => ({
  readSessionTranscriptSummaryAsync: async (
    _scope: unknown,
    query: import("./session-transcript-summary.js").SessionTranscriptSummaryQuery,
  ) => {
    if (query.kind !== "mcp-app") {
      throw new Error("Expected MCP transcript query");
    }
    const { selectMcpAppReconstructionData } = await import("./mcp-app-transcript.js");
    return {
      kind: "mcp-app",
      data: selectMcpAppReconstructionData((visit) => {
        mocks.visitSessionMessagesAsync(_scope, visit);
      }, query.lookup),
    };
  },
}));
// mock-isolation: transcript reconstruction tests control session identity without a live store.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: mocks.loadSessionEntry,
}));

import { mintMcpAppViewFromTranscript, restoreMcpAppView } from "./mcp-app-reconstruction.js";

const runtime = { mcpAppsEnabled: true };
const view = { id: "view-lease" };

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.resolveAgentDir.mockReturnValue("/tmp/agent");
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace");
  mocks.loadSessionEntry.mockReturnValue({
    canonicalKey: "agent:main:main",
    entry: { sessionId: "session-1" },
    storePath: "/tmp/sessions.json",
  });
  mocks.acquireSessionMcpRuntime.mockResolvedValue({
    runtime,
    releaseLease: mocks.releaseLease,
  });
  mocks.fetchMcpAppView.mockImplementation(async (params: { viewId?: string }) => ({
    viewId: params.viewId ?? "mcp-app-fresh",
  }));
  mocks.getMcpAppViewLease.mockReturnValue(view);
});

async function restoreFromMessages(messages: unknown[], viewId: string) {
  setMessages(messages);
  return await restoreMcpAppView({ cfg: {}, sessionKey: "agent:main:main", viewId });
}

function setMessages(messages: unknown[]) {
  mocks.visitSessionMessagesAsync.mockImplementation(
    (_scope: unknown, visit: (message: unknown) => void) => {
      for (const message of messages) {
        visit(message);
      }
    },
  );
}

const appTool = { serverName: "demo", toolName: "show", uiResourceUri: "ui://demo/app" };
function toolCall(id = "call-1", args: object = {}, name = "demo__show", inputKey = "args") {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, [inputKey]: args }],
  };
}

function toolResult(viewId: string, toolCallId: string, extraDescriptor: object = {}) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "demo__show",
    content: [{ type: "text", text: "ok" }],
    details: {
      mcpServer: "demo",
      mcpTool: "show",
      structuredContent: { city: "Paris" },
      mcpAppPreview: { mcpApp: { ...appTool, viewId, toolCallId, ...extraDescriptor } },
    },
  };
}

describe("MCP App transcript reconstruction", () => {
  it("mints a fresh board lease for global owned by work", async () => {
    const sessionKey = "global";
    const agentId = "work";
    mocks.loadSessionEntry.mockReturnValue({
      canonicalKey: sessionKey,
      entry: { sessionId: "session-1" },
      storePath: "/tmp/openclaw-agent.sqlite",
    });
    setMessages([
      toolCall("call-1", { city: "Paris" }, "demo__show", "arguments"),
      toolResult("mcp-app-original", "call-1"),
    ]);

    const authorizeAppInteraction = vi.fn(async () => true);
    await expect(
      mintMcpAppViewFromTranscript({
        cfg: {},
        sessionKey,
        agentId,
        descriptor: {
          ...appTool,
          toolCallId: "call-1",
        },
        allowedAppToolNames: new Set(["refresh"]),
        authorizeAppInteraction,
        readOnly: false,
      }),
    ).resolves.toEqual({ runtime, view });
    expect(mocks.fetchMcpAppView).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId,
        allowedAppToolNames: new Set(["refresh"]),
        authorizeAppInteraction,
        toolCallId: "call-1",
      }),
    );
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith({
      cfg: {},
      key: sessionKey,
      agentId,
    });
    expect(mocks.fetchMcpAppView.mock.calls.at(-1)?.[0]).not.toHaveProperty("viewId");
  });

  it.each(["disabled", "no view", "aborted"])(
    "releases runtime admission when reconstruction is %s",
    async (outcome) => {
      if (outcome === "disabled") {
        mocks.acquireSessionMcpRuntime.mockResolvedValue({
          runtime: { mcpAppsEnabled: false },
          releaseLease: mocks.releaseLease,
        });
      } else if (outcome === "no view") {
        mocks.fetchMcpAppView.mockResolvedValue(undefined);
      } else {
        mocks.fetchMcpAppView.mockRejectedValue(new DOMException("aborted", "AbortError"));
      }
      const restored = restoreFromMessages(
        [toolCall(), toolResult("mcp-app-abandoned", "call-1")],
        "mcp-app-abandoned",
      );
      if (outcome === "aborted") {
        await expect(restored).rejects.toMatchObject({ name: "AbortError" });
      } else {
        await expect(restored).resolves.toBeUndefined();
      }
      expect(mocks.releaseLease).toHaveBeenCalledOnce();
    },
  );

  it("rejects client-selected descriptors that do not match transcript ownership", async () => {
    await expect(
      restoreFromMessages(
        [
          {
            ...toolResult("mcp-app-ownership", "call-1"),
            toolCallId: "call-other",
          },
        ],
        "mcp-app-ownership",
      ),
    ).resolves.toBeUndefined();
    expect(mocks.fetchMcpAppView).not.toHaveBeenCalled();
  });

  it("binds reused call IDs to the nearest preceding matching tool", async () => {
    const restored = await restoreFromMessages(
      [
        toolCall("shared", { secret: 1 }, "other__tool"),
        toolCall("shared", { page: 2 }),
        toolResult("mcp-app-reused", "shared"),
        toolCall("shared", { page: 3 }),
      ],
      "mcp-app-reused",
    );

    expect(restored).toEqual({ runtime, view });
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
    expect(mocks.fetchMcpAppView).toHaveBeenCalledWith({
      runtime,
      agentId: "main",
      serverName: "demo",
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      toolCallId: "shared",
      toolInput: { page: 2 },
      toolResult: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { city: "Paris" },
      },
      viewId: "mcp-app-reused",
      allowedAppToolNames: new Set(),
      readOnly: true,
    });
  });

  it("declines reconstruction when app-only result metadata was not persisted", async () => {
    await expect(
      restoreFromMessages(
        [toolCall(), toolResult("mcp-app-meta", "call-1", { resultMetaState: "unavailable" })],
        "mcp-app-meta",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a descriptor without its matching tool-call input", async () => {
    await expect(
      restoreFromMessages([toolResult("mcp-app-missing", "call-1")], "mcp-app-missing"),
    ).resolves.toBeUndefined();
  });

  it("streams the full active transcript instead of limiting reconstruction to its tail", async () => {
    const messages = [
      toolCall("call-1", { page: 1 }),
      toolResult("mcp-app-stream", "call-1"),
      ...Array.from({ length: 2_500 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `later-${index}` }],
      })),
    ];

    await restoreFromMessages(messages, "mcp-app-stream");

    expect(mocks.fetchMcpAppView).toHaveBeenCalledWith(
      expect.objectContaining({ toolInput: { page: 1 } }),
    );
  });
});
