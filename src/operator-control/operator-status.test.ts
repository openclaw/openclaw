import { beforeEach, describe, expect, it, vi } from "vitest";

const compileOperatorAgentRegistryMock = vi.hoisted(() => vi.fn());
const getAcpRuntimeBackendMock = vi.hoisted(() => vi.fn());
const listOperatorMemoryMock = vi.hoisted(() => vi.fn());
const getOperatorTaskStatusSummaryMock = vi.hoisted(() => vi.fn());
const getOperatorTaskStorePathMock = vi.hoisted(() => vi.fn());
const getOperatorDebSyncStatusMock = vi.hoisted(() => vi.fn());
const getOperatorDelegatedTransportStatusMock = vi.hoisted(() => vi.fn());
const getOperatorWorkerStatusMock = vi.hoisted(() => vi.fn());

vi.mock("./agent-registry.js", () => ({
  compileOperatorAgentRegistry: compileOperatorAgentRegistryMock,
}));

vi.mock("../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: getAcpRuntimeBackendMock,
}));

vi.mock("./memory-store.js", () => ({
  listOperatorMemory: listOperatorMemoryMock,
}));

vi.mock("./task-store.js", () => ({
  getOperatorTaskStatusSummary: getOperatorTaskStatusSummaryMock,
  getOperatorTaskStorePath: getOperatorTaskStorePathMock,
}));

vi.mock("./deb-sync.js", () => ({
  getOperatorDebSyncStatus: getOperatorDebSyncStatusMock,
}));

vi.mock("./worker-status.js", () => ({
  getOperatorDelegatedTransportStatus: getOperatorDelegatedTransportStatusMock,
  getOperatorWorkerStatus: getOperatorWorkerStatusMock,
}));

describe("operator status", () => {
  beforeEach(() => {
    compileOperatorAgentRegistryMock.mockReset();
    getAcpRuntimeBackendMock.mockReset();
    listOperatorMemoryMock.mockReset();
    getOperatorTaskStatusSummaryMock.mockReset();
    getOperatorTaskStorePathMock.mockReset();
    getOperatorDebSyncStatusMock.mockReset();
    getOperatorDelegatedTransportStatusMock.mockReset();
    getOperatorWorkerStatusMock.mockReset();

    compileOperatorAgentRegistryMock.mockReturnValue({
      agentCount: 3,
      teamCount: 4,
      sourcePath: "memory/reference/agents.yaml",
      sourceHash: "registry-hash",
      generatedAt: 1234,
    });
    getAcpRuntimeBackendMock.mockReturnValue({ id: "codex" });
    listOperatorMemoryMock.mockReturnValue({
      authority: "tonya",
      storePath: "/tmp/operator-memory.json",
      collections: [],
    });
    getOperatorTaskStatusSummaryMock.mockReturnValue({
      primaryOperator: "tonya",
      fallbackOperator: "tony",
      tasks: {
        accepted: 0,
        queued: 1,
        started: 0,
        retrying: 0,
        blocked: 0,
        completed: 0,
        "dead-letter": 0,
      },
      totals: {
        total: 1,
        terminal: 0,
        active: 1,
      },
    });
    getOperatorTaskStorePathMock.mockReturnValue("/tmp/operator-tasks.json");
    getOperatorWorkerStatusMock.mockReturnValue({
      dispatchTransport: "2tony-http",
      role: "legacy-worker-fleet",
      configured: true,
      baseUrl: "http://2tony.internal:8787",
      receiptTemplate: "http://tonya.internal/receipts/{taskId}",
      authScheme: "bearer",
      authEnv: "OPENCLAW_OPERATOR_2TONY_SHARED_SECRET",
      authConfigured: true,
    });
    getOperatorDebSyncStatusMock.mockReturnValue({
      configured: true,
      baseUrl: "http://deb.internal:8788",
      authScheme: "bearer",
      authEnv: "OPENCLAW_OPERATOR_DEB_SHARED_SECRET",
      authConfigured: true,
    });
    getOperatorDelegatedTransportStatusMock.mockReturnValue({
      dispatchTransport: "delegated-http",
      transportAliases: ["angela-http"],
      role: "delegated-first-class-agent-boundary",
      configured: true,
      baseUrl: "http://tonya.internal:18789",
      authScheme: "bearer",
      authEnv: "OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET",
      authConfigured: true,
      globalDefaultAlias: "tonys-angels",
      servedTeams: ["engineering", "marketing"],
      leadAliases: ["bobby-digital", "tonys-angels"],
      defaultAliasByTeam: {
        engineering: "bobby-digital",
        marketing: "tonys-angels",
      },
      teamTopology: [],
      legacyTeams: ["execution-fleet"],
    });
  });

  it("foregrounds delegated transport while preserving legacy aliases", async () => {
    const { getOperatorControlStatus } = await import("./operator-status.js");
    const snapshot = getOperatorControlStatus();

    expect(snapshot.legacyWorkerFleet).toMatchObject({
      dispatchTransport: "2tony-http",
      role: "legacy-worker-fleet",
    });
    expect(snapshot.delegatedFirstClassAgents).toMatchObject({
      dispatchTransport: "delegated-http",
      transportAliases: ["angela-http"],
      role: "delegated-first-class-agent-boundary",
      servedTeams: ["engineering", "marketing"],
    });
    expect(snapshot.worker).toBe(snapshot.legacyWorkerFleet);
    expect(snapshot.mesh.legacyExecutionFleet).toBe(snapshot.legacyWorkerFleet);
    expect(snapshot.mesh.executionFleet).toBe(snapshot.legacyWorkerFleet);
    expect(snapshot.mesh.delegatedFirstClassAgents).toBe(snapshot.delegatedFirstClassAgents);
    expect(snapshot.mesh.domainOrchestrators).toBe(snapshot.delegatedFirstClassAgents);
    expect(snapshot.mesh.marketing).toBe(snapshot.delegatedFirstClassAgents);
  });
});
