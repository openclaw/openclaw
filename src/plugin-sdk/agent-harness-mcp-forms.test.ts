import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import {
  createHarnessMcpFormResourceContext,
  type AgentHarnessMcpFormResourceParamsV1,
} from "./codex-mcp-projection.js";

const mocks = vi.hoisted(() => ({
  create:
    vi.fn<
      (params: { origin: AgentHarnessMcpFormResourceParamsV1["origin"] }) => Promise<undefined>
    >(),
  upload: vi.fn<typeof import("../agents/mcp-form-resource-upload.js").prepareMcpAppFormUpload>(),
}));
vi.mock("../gateway/mcp-app-form-resources.js", () => ({
  createMcpAppFormResourceContext: mocks.create,
}));
vi.mock("../agents/mcp-form-resource-upload.js", () => ({ prepareMcpAppFormUpload: mocks.upload }));
beforeEach(() => {
  vi.resetAllMocks();
});

const runtime: SessionMcpRuntime = {
  sessionId: "form-session",
  sessionKey: "agent:main:form",
  workspaceDir: "/workspace",
  configFingerprint: "test",
  createdAt: 0,
  lastUsedAt: 0,
  getCatalog: async () => {
    throw new Error("unexpected discovery");
  },
  peekCatalog: () => null,
  markUsed: () => {},
  callTool: async () => {
    throw new Error("unexpected tool call");
  },
  dispose: async () => {},
};

describe("harness form capability boundary", () => {
  it("does not pass Gateway request options or an upload implementation to the harness", async () => {
    const prepareToolCall = vi.fn<
      NonNullable<AgentHarnessMcpFormResourceParamsV1["origin"]["prepareToolCall"]>
    >(async () => {});
    const assertCurrent = vi.fn();
    const signal = new AbortController().signal;
    await createHarnessMcpFormResourceContext({
      version: 1,
      requestId: "request",
      snapshot: {},
      signal,
      origin: {
        runtime,
        serverName: "server",
        agentId: "main",
        sessionKey: "agent:main:form",
        assertCurrent,
        prepareToolCall,
      },
    });
    const created = mocks.create.mock.calls[0]![0];
    const request = {
      toolName: "preview",
      input: { id: "part" },
      assertCurrent,
      signal,
      options: { secretDispatchState: "must stay in core" },
    };
    // Extra caller fields are legal structurally, but the host adapter strips
    // them instead of forwarding a Gateway request object across the SDK.
    await created.origin.prepareToolCall?.(request);
    expect(prepareToolCall).toHaveBeenCalledWith({
      toolName: "preview",
      input: { id: "part" },
      assertCurrent,
      signal,
    });
    expect(Object.keys(prepareToolCall.mock.calls[0]![0] ?? {})).not.toContain("options");
    expect(created).not.toHaveProperty("version");
    expect(mocks.upload).toHaveBeenCalledOnce();
  });

  it("refuses resource preparation after origin closure", async () => {
    await expect(
      createHarnessMcpFormResourceContext({
        version: 1,
        requestId: "closed",
        snapshot: {},
        signal: new AbortController().signal,
        origin: {
          runtime,
          serverName: "server",
          agentId: "main",
          sessionKey: "agent:main:form",
          assertCurrent: () => {
            throw new Error("origin closed");
          },
        },
      }),
    ).rejects.toThrow("origin closed");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
