import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMcpAppView: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  acquireSessionMcpRuntime: vi.fn(),
  releaseLease: vi.fn(),
  loadSessionEntry: vi.fn(),
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
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
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
const viewId = "mcp-app-restored";
const defaultSessionKey = "agent:main:main";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadSessionEntry.mockReturnValue({
    canonicalKey: defaultSessionKey,
    entry: { sessionId: "session-1" },
    storePath: "/tmp/sessions.json",
  });
  mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime, releaseLease: mocks.releaseLease });
  mocks.fetchMcpAppView.mockImplementation(async (params: { viewId?: string }) => ({
    viewId: params.viewId ?? "mcp-app-fresh",
  }));
  mocks.getMcpAppViewLease.mockReturnValue(view);
});

async function restoreFromMessages(messages: unknown[]) {
  setMessages(messages);
  return await restoreMcpAppView({ cfg: {}, sessionKey: defaultSessionKey, viewId });
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

function toolResult(toolCallId = "call-1", extraDescriptor: object = {}) {
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
    setMessages([toolCall("call-1", { city: "Paris" }, "demo__show", "arguments"), toolResult()]);

    const authorizeAppInteraction = vi.fn(async () => true);
    await expect(
      mintMcpAppViewFromTranscript({
        cfg: {},
        sessionKey,
        agentId,
        descriptor: { ...appTool, toolCallId: "call-1" },
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
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith({ cfg: {}, key: sessionKey, agentId });
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
      const restored = restoreFromMessages([toolCall(), toolResult()]);
      if (outcome === "aborted") {
        await expect(restored).rejects.toMatchObject({ name: "AbortError" });
      } else {
        await expect(restored).resolves.toBeUndefined();
      }
      expect(mocks.releaseLease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      reason: "mismatched transcript ownership",
      messages: [{ ...toolResult(), toolCallId: "call-other" }],
    },
    {
      reason: "unpersisted app metadata",
      messages: [toolCall(), toolResult("call-1", { resultMetaState: "unavailable" })],
    },
    { reason: "missing tool-call input", messages: [toolResult()] },
  ])("declines reconstruction with $reason", async ({ messages }) => {
    await expect(restoreFromMessages(messages)).resolves.toBeUndefined();
    expect(mocks.fetchMcpAppView).not.toHaveBeenCalled();
  });

  it("binds reused call IDs to the nearest preceding matching tool", async () => {
    const restored = await restoreFromMessages([
      toolCall("shared", { secret: 1 }, "other__tool"),
      toolCall("shared", { page: 2 }),
      toolResult("shared"),
      toolCall("shared", { page: 3 }),
    ]);

    expect(restored).toEqual({ runtime, view });
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
    expect(mocks.fetchMcpAppView).toHaveBeenCalledWith({
      runtime,
      agentId: "main",
      ...appTool,
      toolCallId: "shared",
      toolInput: { page: 2 },
      toolResult: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { city: "Paris" },
      },
      viewId,
      allowedAppToolNames: new Set(),
      readOnly: true,
    });
  });

  it("streams the full active transcript instead of limiting reconstruction to its tail", async () => {
    await restoreFromMessages([
      toolCall("call-1", { page: 1 }),
      toolResult(),
      ...Array.from({ length: 2_500 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `later-${index}` }],
      })),
    ]);
    expect(mocks.fetchMcpAppView).toHaveBeenCalledWith(
      expect.objectContaining({ toolInput: { page: 1 } }),
    );
  });
});
