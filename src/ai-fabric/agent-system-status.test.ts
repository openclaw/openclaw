import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSystemStatusParams } from "./agent-system-status.js";
import type { AgentSystem, AgentSystemStatus } from "./types.js";
import {
  getAgentSystemStatus,
  mapAgentSystemHealth,
  normalizeAgentSystemStatus,
} from "./agent-system-status.js";

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

const IAM_TOKEN_RESPONSE = {
  token: "iam-jwt-token-abc",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

function createMockFetch(
  responses: Array<{ status: number; body?: unknown }>,
): ReturnType<typeof vi.fn> {
  const impl = vi.fn();
  for (const response of responses) {
    impl.mockResolvedValueOnce({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body ?? {})),
      headers: new Headers(),
    });
  }
  return impl;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgentSystem(
  overrides: Partial<AgentSystem> & { id: string; name: string },
): AgentSystem {
  return {
    status: "RUNNING",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const BASE_PARAMS: Omit<AgentSystemStatusParams, "fetchImpl"> = {
  projectId: "proj-123",
  auth: { keyId: "test-key-id", secret: "test-secret" },
  baseUrl: "https://test-api.example.com/api/v1",
  iamUrl: "https://iam.test/token",
};

// ---------------------------------------------------------------------------
// Tests — normalizeAgentSystemStatus
// ---------------------------------------------------------------------------

describe("normalizeAgentSystemStatus", () => {
  it("strips AGENT_SYSTEM_STATUS_ prefix", () => {
    expect(normalizeAgentSystemStatus("AGENT_SYSTEM_STATUS_RUNNING")).toBe("RUNNING");
  });

  it("returns bare status unchanged", () => {
    expect(normalizeAgentSystemStatus("RUNNING")).toBe("RUNNING");
  });

  it("passes unknown raw values through", () => {
    expect(normalizeAgentSystemStatus("NEW_STATUS")).toBe("NEW_STATUS");
  });
});

// ---------------------------------------------------------------------------
// Tests — mapAgentSystemHealth
// ---------------------------------------------------------------------------

describe("mapAgentSystemHealth", () => {
  it("maps RUNNING to healthy", () => {
    expect(mapAgentSystemHealth("RUNNING")).toBe("healthy");
  });

  it("maps degraded statuses correctly", () => {
    const degraded: AgentSystemStatus[] = [
      "COOLED",
      "SUSPENDED",
      "PULLING",
      "RESOURCE_ALLOCATION",
      "AGENT_UNAVAILABLE",
      "ON_SUSPENSION",
    ];
    for (const status of degraded) {
      expect(mapAgentSystemHealth(status)).toBe("degraded");
    }
  });

  it("maps failed statuses correctly", () => {
    const failed: AgentSystemStatus[] = ["FAILED", "DELETED"];
    for (const status of failed) {
      expect(mapAgentSystemHealth(status)).toBe("failed");
    }
  });

  it("maps unknown statuses correctly", () => {
    const unknown: AgentSystemStatus[] = ["UNKNOWN", "ON_DELETION"];
    for (const status of unknown) {
      expect(mapAgentSystemHealth(status)).toBe("unknown");
    }
  });

  it("strips prefix before mapping", () => {
    expect(mapAgentSystemHealth("AGENT_SYSTEM_STATUS_COOLED")).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Tests — getAgentSystemStatus
// ---------------------------------------------------------------------------

describe("getAgentSystemStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns healthy agent systems with correct health mapping", async () => {
    const liveSystems: AgentSystem[] = [
      makeAgentSystem({
        id: "sys-1",
        name: "research-team",
        description: "Research team system",
        options: {
          agents: [{ agentId: "a1" }, { agentId: "a2" }, { agentId: "a3" }],
        },
      }),
      makeAgentSystem({
        id: "sys-2",
        name: "support-team",
        options: {
          agents: [{ agentId: "a4" }],
        },
      }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveSystems, total: 2 } },
    ]);

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].health).toBe("healthy");
    expect(result.entries[0].memberCount).toBe(3);
    expect(result.entries[0].description).toBe("Research team system");
    expect(result.entries[1].memberCount).toBe(1);
    expect(result.summary).toEqual({ total: 2, healthy: 2, degraded: 0, failed: 0, unknown: 0 });
  });

  it("filters out deleted and on-deletion systems", async () => {
    const liveSystems: AgentSystem[] = [
      makeAgentSystem({ id: "sys-1", name: "active-sys" }),
      makeAgentSystem({ id: "sys-2", name: "deleted-sys", status: "DELETED" }),
      makeAgentSystem({ id: "sys-3", name: "deleting-sys", status: "ON_DELETION" }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveSystems, total: 3 } },
    ]);

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe("active-sys");
  });

  it("filters systems by name (case-insensitive)", async () => {
    const liveSystems: AgentSystem[] = [
      makeAgentSystem({ id: "sys-1", name: "research-team" }),
      makeAgentSystem({ id: "sys-2", name: "support-team" }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveSystems, total: 2 } },
    ]);

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      nameFilter: "Research",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe("research-team");
  });

  it("handles systems without options.agents gracefully", async () => {
    const liveSystems: AgentSystem[] = [makeAgentSystem({ id: "sys-1", name: "empty-sys" })];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveSystems, total: 1 } },
    ]);

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries[0].memberCount).toBe(0);
  });

  it("returns config error when projectId is missing", async () => {
    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      projectId: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("config");
    expect(result.error).toContain("projectId");
  });

  it("returns config error when credentials are missing", async () => {
    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      auth: { keyId: "", secret: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("config");
    expect(result.error).toContain("credentials");
  });

  it("returns auth error for IAM failure", async () => {
    const fetchImpl = createMockFetch([{ status: 401, body: { message: "invalid credentials" } }]);

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("auth");
    expect(result.error).toContain("IAM auth failed");
  });

  it("returns API error for non-auth HTTP errors", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 404, body: { message: "project not found" } },
    ]);

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("api");
    expect(result.error).toContain("404");
  });

  it("returns network error for connection failures", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), {
      code: "ENOTFOUND",
    });
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(IAM_TOKEN_RESPONSE),
      text: () => Promise.resolve(JSON.stringify(IAM_TOKEN_RESPONSE)),
      headers: new Headers(),
    });
    fetchImpl.mockRejectedValueOnce(new TypeError("fetch failed", { cause }));

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("network");
    expect(result.error).toContain("ENOTFOUND");
  });

  it("computes summary rollup correctly across health states", async () => {
    const liveSystems: AgentSystem[] = [
      makeAgentSystem({ id: "sys-1", name: "running-sys", status: "RUNNING" }),
      makeAgentSystem({ id: "sys-2", name: "cooled-sys", status: "COOLED" }),
      makeAgentSystem({ id: "sys-3", name: "failed-sys", status: "FAILED" }),
      makeAgentSystem({ id: "sys-4", name: "unknown-sys", status: "UNKNOWN" }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveSystems, total: 4 } },
    ]);

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.summary).toEqual({
      total: 4,
      healthy: 1,
      degraded: 1,
      failed: 1,
      unknown: 1,
    });
  });

  it("preserves endpoint on entries", async () => {
    const liveSystems: AgentSystem[] = [
      makeAgentSystem({
        id: "sys-1",
        name: "research-team",
        endpoint: "https://sys-1-agent-system.ai-agent.inference.cloud.ru",
      }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveSystems, total: 1 } },
    ]);

    const result = await getAgentSystemStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries[0].endpoint).toBe(
      "https://sys-1-agent-system.ai-agent.inference.cloud.ru",
    );
  });
});
