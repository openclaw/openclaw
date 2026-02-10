import { describe, expect, it, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  loadConfigReturn: {} as Record<string, unknown>,
  listAgentIdsReturn: ["main", "coding", "books"] as string[],
  listAgentsForGatewayReturn: {
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
    agents: [
      { agentId: "main", name: "Mia" },
      { agentId: "coding", name: "Dev" },
      { agentId: "books", name: "Books" },
    ],
  },
  sessionStoreReturn: {
    "agent:main:main": {
      key: "agent:main:main",
      model: "claude-opus-4-6",
      totalTokens: 100000,
      updatedAt: Date.now() - 5 * 60 * 1000, // 5 min ago
    },
    "agent:coding:main": {
      key: "agent:coding:main",
      model: "claude-opus-4-6",
      totalTokens: 74000,
      updatedAt: Date.now() - 2 * 60 * 1000, // 2 min ago
    },
  } as Record<string, unknown>,
  cronListReturn: [
    {
      id: "job-1",
      agentId: "coding",
      name: "Ticket Nudger",
      enabled: true,
      state: {
        lastStatus: "ok",
        nextRunAtMs: Date.now() + 600_000,
        lastRunAtMs: Date.now() - 60_000,
        lastDurationMs: 13000,
      },
    },
    {
      id: "job-2",
      agentId: "coding",
      name: "Daily Report",
      enabled: true,
      state: {
        lastStatus: "error",
        nextRunAtMs: Date.now() + 3600_000,
        lastRunAtMs: Date.now() - 300_000,
        lastDurationMs: 5000,
      },
    },
    {
      id: "job-3",
      agentId: "main",
      name: "Backup",
      enabled: true,
      state: {
        lastStatus: "ok",
        nextRunAtMs: Date.now() + 7200_000,
        lastRunAtMs: Date.now() - 1800_000,
        lastDurationMs: 17000,
      },
    },
    {
      id: "job-4",
      agentId: "main",
      name: "Disabled Job",
      enabled: false,
      state: {},
    },
  ],
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => mocks.listAgentIdsReturn,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigReturn,
}));

vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: () => mocks.listAgentsForGatewayReturn,
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: () => mocks.sessionStoreReturn,
}));

vi.mock("../../routing/session-key.js", () => ({
  parseAgentSessionKey: (key: string) => {
    const parts = key.split(":");
    return { agentId: parts[1] ?? "main" };
  },
}));

vi.mock("../protocol/index.js", () => ({
  ErrorCodes: { INTERNAL_ERROR: -32603, INVALID_REQUEST: -32600 },
  errorShape: (code: number, msg: string) => ({ code, message: msg }),
}));

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("agents.health", () => {
  let handler: (opts: Record<string, unknown>) => Promise<void>;

  beforeEach(async () => {
    const mod = await import("./agents-health.js");
    handler = mod.agentsHealthHandlers["agents.health"] as typeof handler;
  });

  it("returns health for all agents", async () => {
    let result: Record<string, unknown> | undefined;
    const respond = vi.fn((ok: boolean, payload: unknown) => {
      result = payload as Record<string, unknown>;
    });

    const context = {
      cron: {
        list: vi.fn(async () => ({ jobs: mocks.cronListReturn })),
      },
    };

    await handler({
      respond,
      context,
      params: {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    const agents = (result as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(3);

    // Main agent — healthy, 1 cron job enabled
    const main = agents.find((a) => a.agentId === "main")!;
    expect(main.status).toBe("healthy");
    expect(main.mainSession).toBeTruthy();
    expect((main.cron as Record<string, unknown>).enabled).toBe(1);
    expect((main.cron as Record<string, unknown>).total).toBe(2);

    // Coding agent — warning (1 failing cron)
    const coding = agents.find((a) => a.agentId === "coding")!;
    expect(coding.status).toBe("warning");
    expect(coding.statusReason).toContain("failing");
    expect((coding.cron as Record<string, unknown>).failing).toBe(1);

    // Books agent — unknown (no session, no crons)
    const books = agents.find((a) => a.agentId === "books")!;
    expect(books.status).toBe("unknown");
    expect(books.mainSession).toBeNull();
  });

  it("includes generatedAtMs timestamp", async () => {
    let result: Record<string, unknown> | undefined;
    const respond = vi.fn((_ok: boolean, payload: unknown) => {
      result = payload as Record<string, unknown>;
    });

    const context = {
      cron: { list: vi.fn(async () => ({ jobs: [] })) },
    };

    const before = Date.now();
    await handler({
      respond,
      context,
      params: {},
      req: {},
      client: null,
      isWebchatConnect: () => false,
    });
    const after = Date.now();

    expect((result as Record<string, unknown>).generatedAtMs).toBeGreaterThanOrEqual(before);
    expect((result as Record<string, unknown>).generatedAtMs).toBeLessThanOrEqual(after);
  });
});
