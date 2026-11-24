import { beforeEach, expect, it, vi } from "vitest";
import {
  createHarnessMcpFormResourceContext as createContext,
  type AgentHarnessMcpFormResourceParamsV1 as FormParams,
} from "./codex-mcp-projection.js";
type Origin = FormParams["origin"];

const mocks = vi.hoisted(() => ({
  create: vi.fn<(params: { origin: Origin }) => Promise<undefined>>(),
  upload: vi.fn<typeof import("../agents/mcp-form-resource-upload.js").prepareMcpAppFormUpload>(),
}));
vi.mock("../gateway/mcp-app-form-resources.js", () => ({
  createMcpAppFormResourceContext: mocks.create,
}));
vi.mock("../agents/mcp-form-resource-upload.js", () => ({ prepareMcpAppFormUpload: mocks.upload }));
beforeEach(() => {
  vi.resetAllMocks();
});

const unexpected = async () => {
  throw new Error("unexpected MCP access");
};
const formParams = (origin: Partial<Origin>): FormParams => ({
  version: 1,
  requestId: "request",
  snapshot: {},
  signal: new AbortController().signal,
  origin: {
    serverName: "server",
    agentId: "main",
    sessionKey: "agent:main:form",
    assertCurrent: vi.fn(),
    ...origin,
    runtime: {
      sessionKey: "agent:main:form",
      sessionId: "form-session",
      workspaceDir: "/workspace",
      configFingerprint: "test",
      createdAt: 0,
      lastUsedAt: 0,
      getCatalog: unexpected,
      peekCatalog: () => null,
      markUsed: () => {},
      callTool: unexpected,
      dispose: async () => {},
    },
  },
});

it("does not pass Gateway request options or an upload implementation to the harness", async () => {
  const prepareToolCall = vi.fn<NonNullable<Origin["prepareToolCall"]>>(async () => {});
  const params = formParams({ prepareToolCall });
  const { signal } = params;
  const { assertCurrent } = params.origin;
  await createContext(params);
  const created = mocks.create.mock.calls[0]![0];
  const publicRequest = {
    toolName: "preview",
    input: { id: "part" },
    assertCurrent,
    signal,
  };
  const request = { ...publicRequest, options: { secretDispatchState: "must stay in core" } };
  await created.origin.prepareToolCall?.(request);
  expect(prepareToolCall).toHaveBeenCalledWith(publicRequest);
  expect(created).not.toHaveProperty("version");
  expect(mocks.upload).toHaveBeenCalledOnce();
});

it("refuses resource preparation after origin closure", async () => {
  const params = formParams({
    assertCurrent: () => {
      throw new Error("origin closed");
    },
  });
  await expect(createContext(params)).rejects.toThrow("origin closed");
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
});
