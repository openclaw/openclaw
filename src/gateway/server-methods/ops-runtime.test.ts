import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  loadCombinedSessionStoreForGateway: vi.fn(() => ({ storePath: "(multiple)", store: {} })),
  listSessionsFromStore: vi.fn(() => ({
    ts: Date.now(),
    path: "(multiple)",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  })),
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: mocks.loadCombinedSessionStoreForGateway,
  listSessionsFromStore: mocks.listSessionsFromStore,
}));

vi.mock("../../agents/subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: mocks.loadSubagentRegistryFromDisk,
}));

const { opsRuntimeHandlers } = await import("./ops-runtime.js");

function createHandlerContext() {
  return {
    cron: {
      list: vi.fn(async () => []),
    },
  } as unknown as Parameters<(typeof opsRuntimeHandlers)["ops.runtime.summary"]>[0]["context"];
}

describe("ops.runtime.summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      storePath: "(multiple)",
      store: {},
    });
    mocks.listSessionsFromStore.mockReturnValue({
      ts: Date.now(),
      path: "(multiple)",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:main:discord:channel:1",
          kind: "group",
          updatedAt: Date.now() - 30_000,
          abortedLastRun: false,
          model: "gpt-5.2",
          displayName: "main session",
        },
        {
          key: "agent:codex:discord:channel:2",
          kind: "group",
          updatedAt: Date.now() - 10_000,
          abortedLastRun: true,
          model: "gpt-5.3-codex",
          displayName: "model failover fix",
        },
      ],
    });
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          "run-1",
          {
            runId: "run-1",
            childSessionKey: "agent:codex:discord:channel:2",
            requesterSessionKey: "agent:main:discord:channel:1",
            requesterDisplayKey: "main",
            task: "fix model failover in discord",
            cleanup: "keep",
            createdAt: Date.now() - 60_000,
            startedAt: Date.now() - 60_000,
            model: "gpt-5.3-codex",
          },
        ],
      ]),
    );
  });

  it("returns aggregated runtime snapshot with filters applied", async () => {
    const respond = vi.fn();
    const context = createHandlerContext();
    context.cron.list = vi.fn(async () => [
      {
        id: "cron-1",
        name: "model-failover-watch",
        enabled: true,
        createdAtMs: Date.now() - 1_000_000,
        updatedAtMs: Date.now() - 100_000,
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "watch failover" },
        state: {
          lastRunAtMs: Date.now() - 30_000,
          lastStatus: "error",
          lastError: "timed out",
          consecutiveErrors: 1,
        },
      },
    ]);

    await opsRuntimeHandlers["ops.runtime.summary"]({
      req: { type: "req", id: "1", method: "ops.runtime.summary" },
      params: { search: "failover", activeMinutes: 120, limit: 10 },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      summary: {
        cron: { total: 1, warnings: 1, errors: 1 },
        sessions: { total: 1, warnings: 1 },
        subagents: { total: 1, active: 1 },
      },
    });
    expect(payload.filters.search).toBe("failover");
    expect(payload.sessions[0].key).toContain("agent:codex:");
  });

  it("rejects invalid params", async () => {
    const respond = vi.fn();
    const context = createHandlerContext();

    await opsRuntimeHandlers["ops.runtime.summary"]({
      req: { type: "req", id: "1", method: "ops.runtime.summary" },
      params: { activeMinutes: 0 },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toContain("activeMinutes");
  });
});
