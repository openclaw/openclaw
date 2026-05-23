import { describe, expect, it, vi } from "vitest";
import {
  loadMemoryAuditSuggestions,
  normalizeMemoryAuditSuggestions,
  runMemoryAuditAction,
  type MemoryAuditState,
} from "./memory-audit.ts";

function createState(): { state: MemoryAuditState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  return {
    request,
    state: {
      client: { request } as unknown as MemoryAuditState["client"],
      connected: true,
      hello: null,
      memoryAuditLoading: false,
      memoryAuditError: null,
      memoryAuditSuggestions: null,
      memoryAuditActionId: null,
      memoryAuditActionMessage: null,
      lastError: null,
    },
  };
}

function rawSuggestion() {
  return {
    id: "audit-1",
    status: "pending",
    action: "edit",
    text: "Prefer terse status updates.",
    rationale: "The existing durable memory is too broad.",
    confidence: 0.91,
    source: {
      surfaceId: "agent-memory:hex",
      kind: "agent-memory",
      path: "MEMORY.md",
      workspaceDir: "/workspace/hex",
      agentId: "hex",
      startLine: 2,
      endLine: 3,
      hash: "abc123",
    },
    target: {
      surfaceId: "agent-memory:hex",
      kind: "agent-memory",
      path: "MEMORY.md",
      workspaceDir: "/workspace/hex",
      agentId: "hex",
    },
    createdAt: "2026-05-01T06:10:00.000Z",
    updatedAt: "2026-05-01T06:10:00.000Z",
  };
}

describe("memory audit controller", () => {
  it("normalizes the suggestion queue payload", () => {
    const result = normalizeMemoryAuditSuggestions({
      agentId: "hex",
      workspaces: ["/workspace/hex", ""],
      total: 1,
      pending: 1,
      suggestions: [rawSuggestion(), { id: "missing-fields" }],
    });

    expect(result.agentId).toBe("hex");
    expect(result.workspaces).toEqual(["/workspace/hex"]);
    expect(result.total).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.source?.startLine).toBe(2);
  });

  it("keeps delete suggestions with empty replacement text", () => {
    const result = normalizeMemoryAuditSuggestions({
      suggestions: [
        {
          ...rawSuggestion(),
          id: "delete-1",
          action: "delete",
          text: "",
          rationale: "This memory is stale.",
        },
      ],
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toEqual(
      expect.objectContaining({
        id: "delete-1",
        action: "delete",
        text: "",
      }),
    );
  });

  it("loads suggestions from the gateway", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      agentId: "hex",
      workspaces: ["/workspace/hex"],
      total: 1,
      pending: 1,
      suggestions: [rawSuggestion()],
    });

    await loadMemoryAuditSuggestions(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.auditSuggestions", {});
    expect(state.memoryAuditSuggestions?.suggestions[0]?.id).toBe("audit-1");
    expect(state.memoryAuditError).toBeNull();
    expect(state.memoryAuditLoading).toBe(false);
  });

  it("skips loading when the gateway does not advertise audit suggestions", async () => {
    const { state, request } = createState();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["doctor.memory.status"] },
    };

    await loadMemoryAuditSuggestions(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.memoryAuditSuggestions).toBeNull();
    expect(state.memoryAuditError).toContain("doctor.memory.auditSuggestions");
  });

  it("applies pending suggestions and refreshes the queue", async () => {
    const { state, request } = createState();
    const suggestion = normalizeMemoryAuditSuggestions({
      suggestions: [rawSuggestion()],
    }).suggestions[0];
    if (!suggestion) {
      throw new Error("expected normalized suggestion");
    }
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.auditApply") {
        return { action: "apply", applied: true };
      }
      if (method === "doctor.memory.auditSuggestions") {
        return { suggestions: [{ ...rawSuggestion(), status: "applied" }] };
      }
      return {};
    });

    await runMemoryAuditAction(state, suggestion, "apply");

    expect(request).toHaveBeenCalledWith("doctor.memory.auditApply", {
      id: "audit-1",
      workspaceDir: "/workspace/hex",
    });
    expect(state.memoryAuditActionMessage).toEqual({
      kind: "success",
      text: "Suggestion applied.",
    });
    expect(state.memoryAuditSuggestions?.applied).toBe(1);
    expect(state.memoryAuditActionId).toBeNull();
  });

  it("does not mutate suggestions while the queue is refreshing", async () => {
    const { state, request } = createState();
    const suggestion = normalizeMemoryAuditSuggestions({
      suggestions: [rawSuggestion()],
    }).suggestions[0];
    if (!suggestion) {
      throw new Error("expected normalized suggestion");
    }
    state.memoryAuditLoading = true;

    await runMemoryAuditAction(state, suggestion, "apply");

    expect(request).not.toHaveBeenCalled();
    expect(state.memoryAuditActionId).toBeNull();
    expect(state.memoryAuditActionMessage).toBeNull();
  });

  it("reports apply conflicts without losing the refreshed queue", async () => {
    const { state, request } = createState();
    const suggestion = normalizeMemoryAuditSuggestions({
      suggestions: [rawSuggestion()],
    }).suggestions[0];
    if (!suggestion) {
      throw new Error("expected normalized suggestion");
    }
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.auditApply") {
        return { action: "apply", applied: false, conflict: "source range changed" };
      }
      return {
        suggestions: [{ ...rawSuggestion(), status: "conflict", conflict: "source range changed" }],
      };
    });

    await runMemoryAuditAction(state, suggestion, "apply");

    expect(state.memoryAuditActionMessage).toEqual({
      kind: "error",
      text: "Could not apply suggestion: source range changed",
    });
    expect(state.memoryAuditSuggestions?.conflict).toBe(1);
  });

  it("reports no-op action responses as errors", async () => {
    const { state, request } = createState();
    const suggestion = normalizeMemoryAuditSuggestions({
      suggestions: [rawSuggestion()],
    }).suggestions[0];
    if (!suggestion) {
      throw new Error("expected normalized suggestion");
    }
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.auditReject") {
        return { action: "reject", rejected: false };
      }
      return { suggestions: [rawSuggestion()] };
    });

    await runMemoryAuditAction(state, suggestion, "reject");

    expect(state.memoryAuditActionMessage).toEqual({
      kind: "error",
      text: "Suggestion was not rejected.",
    });
  });
});
