import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const cfg = {
  agents: { list: [{ id: "main" }, { id: "chief" }, { id: "ops" }] },
  plugins: {
    entries: {
      "memory-core": {
        config: {
          searchScope: { chiefAgentIds: ["chief"] },
        },
      },
    },
  },
} as unknown as OpenClawConfig;

const listAgentIdsMock = vi.hoisted(() => vi.fn(() => ["main", "chief", "ops"]));
const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn(() => "main"));
const getActiveMemorySearchManagerMock = vi.hoisted(() => vi.fn());
const loadSessionEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: listAgentIdsMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getActiveMemorySearchManagerMock,
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
}));

import { __testing, memoryHandlers } from "./memory.js";

function makeRespond() {
  return vi.fn();
}

async function invoke(method: keyof typeof memoryHandlers, params: Record<string, unknown>) {
  const respond = makeRespond();
  await memoryHandlers[method]({
    req: { method, id: "1" } as never,
    params,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function makeManager() {
  return {
    status: vi.fn(() => ({
      backend: "builtin",
      provider: "local",
      model: "test-model",
      files: 2,
      chunks: 3,
      dirty: false,
      workspaceDir: "/secret/workspace/main",
      dbPath: "/secret/state/main.sqlite",
      extraPaths: ["/secret/extra"],
      sources: ["memory"],
      sourceCounts: [{ source: "memory", files: 2, chunks: 3 }],
      vector: { enabled: true, available: true, extensionPath: "/secret/sqlite-vec.so", dims: 384 },
    })),
    search: vi.fn(async () => [
      {
        path: "memory/2026-04-28/2026-04-28.md",
        startLine: 10,
        endLine: 12,
        score: 0.9,
        snippet: "hello",
        source: "memory",
      },
    ]),
    readFile: vi.fn(),
    getCachedEmbeddingAvailability: vi.fn(() => ({ ok: true, cached: true })),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true, checked: true })),
    probeVectorAvailability: vi.fn(async () => true),
    sync: vi.fn(async () => undefined),
  };
}

describe("memory gateway handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.clearMemoryRpcState();
    listAgentIdsMock.mockReturnValue(["main", "chief", "ops"]);
    resolveSessionAgentIdMock.mockReturnValue("main");
    loadSessionEntryMock.mockReturnValue({
      cfg,
      entry: { updatedAt: Date.now() },
      canonicalKey: "agent:main:abc",
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager: makeManager() });
  });

  it("rejects frontend-supplied agent override fields", async () => {
    const respond = await invoke("memory.search.debug", {
      sessionKey: "agent:main:abc",
      query: "hello",
      agentId: "chief",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("unsupported memory RPC param: agentId"),
      }),
    );
    expect(getActiveMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("uses requester session agent scope and does not cross agent for normal agents", async () => {
    const respond = await invoke("memory.search.debug", {
      sessionKey: "agent:main:abc",
      query: "hello",
    });

    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(getActiveMemorySearchManagerMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg, agentId: "main" }),
    );
    expect(respond.mock.calls[0][1].scope).toEqual({
      requesterAgentId: "main",
      allowedAgentIds: ["main"],
      crossAgent: false,
    });
  });

  it("returns provenance and backend-issued source refs from search debug", async () => {
    const respond = await invoke("memory.search.debug", {
      sessionKey: "agent:main:abc",
      query: "hello",
    });

    const payload = respond.mock.calls[0][1];
    expect(payload.results[0]).toEqual(
      expect.objectContaining({
        agentId: "main",
        agent_id: "main",
        sourcePath: "memory/2026-04-28/2026-04-28.md",
        source_path: "memory/2026-04-28/2026-04-28.md",
        start_line: 10,
        end_line: 12,
        sourceRef: expect.stringMatching(/^memsrc_/),
        openTarget: expect.objectContaining({ kind: "memory-source" }),
      }),
    );
  });

  it("sanitizes status paths before returning to frontend", async () => {
    const respond = await invoke("memory.status", { sessionKey: "agent:main:abc" });

    const status = respond.mock.calls[0][1].agents[0].status;
    expect(status).toEqual(
      expect.not.objectContaining({
        workspaceDir: expect.any(String),
        dbPath: expect.any(String),
        extraPaths: expect.any(Array),
      }),
    );
    expect(status.vector).toEqual({ enabled: true, available: true, dims: 384 });
  });
});
