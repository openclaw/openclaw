import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorRequestRecord } from "../orchestrator-request-registry.js";
import type { SubagentRunRecord } from "../subagent-registry.js";
import { createSessionsTreeTool } from "./sessions-tree-tool.js";

const { mockListAllSubagentRuns, mockListPendingRequestsForChild } = vi.hoisted(() => ({
  mockListAllSubagentRuns: vi.fn<() => SubagentRunRecord[]>(() => []),
  mockListPendingRequestsForChild: vi.fn<() => OrchestratorRequestRecord[]>(() => []),
}));

vi.mock("../subagent-registry.js", () => ({
  listAllSubagentRuns: mockListAllSubagentRuns,
}));

vi.mock("../orchestrator-request-registry.js", () => ({
  listPendingRequestsForChild: mockListPendingRequestsForChild,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("./sessions-helpers.js", () => ({
  resolveMainSessionAlias: vi.fn(() => ({ mainKey: "main", alias: "main" })),
  resolveInternalSessionKey: vi.fn(({ key }: { key: string }) => key),
}));

vi.mock("./sessions-lineage.js", () => ({
  getDescendants: vi.fn(() => []),
}));

vi.mock("../../routing/session-key.js", () => ({
  isSubagentSessionKey: vi.fn(() => false),
}));

// Helper to create fake SubagentRunRecord
const makeRun = (overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord => ({
  runId: "run-1",
  requesterSessionKey: "main",
  childSessionKey: "agent:test:subagent:child-1",
  task: "test task",
  createdAt: Date.now() - 60000,
  startedAt: Date.now() - 60000,
  depth: 1,
  ...overrides,
});

// Helper to create fake OrchestratorRequestRecord
const makePendingRequest = (
  overrides: Partial<OrchestratorRequestRecord> = {},
): OrchestratorRequestRecord => ({
  requestId: "req_test-123",
  childSessionKey: "agent:test:subagent:child-1",
  parentSessionKey: "main",
  message: "help needed",
  priority: "normal",
  status: "pending",
  createdAt: Date.now(),
  timeoutAt: Date.now() + 300_000,
  ...overrides,
});

describe("Status projection in tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows running status for active sessions with no requests", async () => {
    // A running session with no pending requests
    mockListAllSubagentRuns.mockReturnValue([
      makeRun({
        runId: "run-active",
        childSessionKey: "agent:test:subagent:child-active",
        endedAt: undefined, // still running
      }),
    ]);
    mockListPendingRequestsForChild.mockReturnValue([]);

    const tool = createSessionsTreeTool();
    const result = await tool.execute("tc-1", {});
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);

    expect(payload.tree).toHaveLength(1);
    const node = payload.tree[0];
    expect(node.status).toBe("running");
    expect(node.runStatus).toBe("running");
    expect(node.pendingRequestCount).toBeUndefined();
  });

  it("shows blocked status for sessions with pending requests", async () => {
    // A running session WITH pending requests
    mockListAllSubagentRuns.mockReturnValue([
      makeRun({
        runId: "run-blocked",
        childSessionKey: "agent:test:subagent:child-blocked",
        endedAt: undefined, // still running
      }),
    ]);
    mockListPendingRequestsForChild.mockReturnValue([
      makePendingRequest({
        requestId: "req-1",
        childSessionKey: "agent:test:subagent:child-blocked",
      }),
      makePendingRequest({
        requestId: "req-2",
        childSessionKey: "agent:test:subagent:child-blocked",
      }),
    ]);

    const tool = createSessionsTreeTool();
    const result = await tool.execute("tc-1", {});
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);

    expect(payload.tree).toHaveLength(1);
    const node = payload.tree[0];
    expect(node.status).toBe("running");
    expect(node.runStatus).toBe("blocked");
    expect(node.pendingRequestCount).toBe(2);
  });

  it("shows pendingRequestCount accurately", async () => {
    // Test with exactly 3 pending requests
    mockListAllSubagentRuns.mockReturnValue([
      makeRun({
        runId: "run-count-test",
        childSessionKey: "agent:test:subagent:child-count",
        endedAt: undefined,
      }),
    ]);
    mockListPendingRequestsForChild.mockReturnValue([
      makePendingRequest({
        requestId: "req-1",
        childSessionKey: "agent:test:subagent:child-count",
      }),
      makePendingRequest({
        requestId: "req-2",
        childSessionKey: "agent:test:subagent:child-count",
      }),
      makePendingRequest({
        requestId: "req-3",
        childSessionKey: "agent:test:subagent:child-count",
      }),
    ]);

    const tool = createSessionsTreeTool();
    const result = await tool.execute("tc-1", {});
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);

    const node = payload.tree[0];
    expect(node.pendingRequestCount).toBe(3);
  });

  it("clears status fields when no pending requests (omits from output)", async () => {
    // A completed session with no pending requests
    mockListAllSubagentRuns.mockReturnValue([
      makeRun({
        runId: "run-completed",
        childSessionKey: "agent:test:subagent:child-completed",
        endedAt: Date.now() - 10000,
        outcome: { status: "ok" },
      }),
    ]);
    mockListPendingRequestsForChild.mockReturnValue([]);

    const tool = createSessionsTreeTool();
    const result = await tool.execute("tc-1", {});
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);

    expect(payload.tree).toHaveLength(1);
    const node = payload.tree[0];
    expect(node.status).toBe("completed");
    expect(node.runStatus).toBeUndefined();
    expect(node.pendingRequestCount).toBeUndefined();
  });
});
