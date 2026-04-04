/**
 * Unit tests for PR #60606: agentId validation in cron.add and cron.update handlers.
 *
 * These tests verify that:
 * - cron.add rejects non-existent agentId with INVALID_REQUEST
 * - cron.add accepts valid agentId and creates the job
 * - cron.update rejects non-existent agentId with INVALID_REQUEST
 * - cron.update accepts valid agentId and updates the job
 *
 * Correct file location in openclaw source repo:
 *   src/gateway/server-methods/cron.test.ts
 *
 * Run with: npx vitest src/gateway/server-methods/cron.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.mock is automatically hoisted to the top of the file,
// so these variables are captured by closure when the factories run.
// ---------------------------------------------------------------------------

const mockRespond = vi.hoisted(() => vi.fn());
const mockLogGateway = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }));
const mockCronAdd = vi.hoisted(() => vi.fn());
const mockCronUpdate = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockIsConfiguredAgent = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("./agents.js", () => ({
  isConfiguredAgent: mockIsConfiguredAgent,
}));

// ---------------------------------------------------------------------------
// Import the handlers after mocks are set up
// ---------------------------------------------------------------------------

import { cronHandlers } from "./cron.js";

// ---------------------------------------------------------------------------
// Constants & fixtures
// ---------------------------------------------------------------------------

const VALID_AGENT_ID = "agent-001";
const UNKNOWN_AGENT_ID = "agent-does-not-exist";

const BASE_JOB_CREATE = {
  name: "test job",
  schedule: { kind: "cron" as const, expr: "0 9 * * *" },
  sessionTarget: "main" as const,
  wakeMode: "now" as const,
  payload: { kind: "systemEvent" as const, text: "hello" },
} as const;

const BASE_PATCH = { name: "updated job" } as const;

// ---------------------------------------------------------------------------
// Helper — build a minimal GatewayRequestHandlerOptions object
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeHandlerOptions(params: Record<string, unknown>): any {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req: { method: "test", id: "req-1", frame: {} } as any,
    params,
    client: null,
    isWebchatConnect: vi.fn().mockReturnValue(false),
    respond: mockRespond,
    context: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: {} as any,
      cron: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        add: mockCronAdd as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: mockCronUpdate as any,
      },
      cronStorePath: "/tmp/cron-store.json",
      loadGatewayModelCatalog: vi.fn(),
      getHealthCache: vi.fn(),
      refreshHealthSnapshot: vi.fn(),
      logHealth: { error: vi.fn() },
      logGateway: mockLogGateway,
      incrementPresenceVersion: vi.fn(),
      getHealthVersion: vi.fn(),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      nodeSendToSession: vi.fn(),
      nodeSendToAllSubscribed: vi.fn(),
      nodeSubscribe: vi.fn(),
      nodeUnsubscribe: vi.fn(),
      nodeUnsubscribeAll: vi.fn(),
      hasConnectedMobileNode: vi.fn().mockReturnValue(false),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodeRegistry: {} as any,
      agentRunSeq: new Map(),
      chatAbortControllers: new Map(),
      chatAbortedRuns: new Map(),
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      addChatRun: vi.fn(),
      removeChatRun: vi.fn(),
      subscribeSessionEvents: vi.fn(),
      unsubscribeSessionEvents: vi.fn(),
      subscribeSessionMessageEvents: vi.fn(),
      unsubscribeSessionMessageEvents: vi.fn(),
      unsubscribeAllSessionEvents: vi.fn(),
      getSessionEventSubscriberConnIds: vi.fn().mockReturnValue(new Set()),
      registerToolEventRecipient: vi.fn(),
      dedupe: new Map(),
      wizardSessions: new Map(),
      findRunningWizard: vi.fn(),
      purgeWizardSession: vi.fn(),
      getRuntimeSnapshot: vi.fn(),
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      markChannelLoggedOut: vi.fn(),
      wizardRunner: vi.fn(),
      broadcastVoiceWakeChanged: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared setup — runs before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: agent-001 is a configured agent; everything else is unknown.
  mockIsConfiguredAgent.mockImplementation(
    (_cfg: unknown, agentId: string) => agentId === VALID_AGENT_ID,
  );
  mockLoadConfig.mockReturnValue({ agents: { list: [{ id: VALID_AGENT_ID }] } });
  mockCronAdd.mockResolvedValue({ id: "job-123", ...BASE_JOB_CREATE });
  mockCronUpdate.mockResolvedValue({ id: "job-123", ...BASE_PATCH });
});

// ---------------------------------------------------------------------------
// Tests — cron.add
// ---------------------------------------------------------------------------

describe("cron.add — agentId validation (PR #60606)", () => {
  it("returns INVALID_REQUEST when agentId refers to an unconfigured agent", async () => {
    const handler = cronHandlers["cron.add"];
    const opts = makeHandlerOptions({ ...BASE_JOB_CREATE, agentId: UNKNOWN_AGENT_ID });

    await handler(opts);

    expect(mockRespond).toHaveBeenCalledOnce();
    const [ok, payload, error] = mockRespond.mock.lastCall ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(error.message).toContain(UNKNOWN_AGENT_ID);
    expect(mockCronAdd).not.toHaveBeenCalled();
  });

  it("does NOT call isConfiguredAgent when agentId is null", async () => {
    const handler = cronHandlers["cron.add"];
    const opts = makeHandlerOptions({ ...BASE_JOB_CREATE, agentId: null });

    await handler(opts);

    expect(mockIsConfiguredAgent).not.toHaveBeenCalled();
    expect(mockCronAdd).toHaveBeenCalledOnce();
    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "job-123" }),
      undefined,
    );
  });

  it("does NOT call isConfiguredAgent when agentId is absent", async () => {
    const handler = cronHandlers["cron.add"];
    const opts = makeHandlerOptions(BASE_JOB_CREATE); // no agentId field

    await handler(opts);

    expect(mockIsConfiguredAgent).not.toHaveBeenCalled();
    expect(mockCronAdd).toHaveBeenCalledOnce();
  });

  it("creates the job successfully when agentId is a configured agent", async () => {
    const handler = cronHandlers["cron.add"];
    const opts = makeHandlerOptions({ ...BASE_JOB_CREATE, agentId: VALID_AGENT_ID });

    await handler(opts);

    expect(mockIsConfiguredAgent).toHaveBeenCalledWith(expect.anything(), VALID_AGENT_ID);
    expect(mockCronAdd).toHaveBeenCalledWith(expect.objectContaining({ agentId: VALID_AGENT_ID }));
    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "job-123" }),
      undefined,
    );
  });

  it("error message includes the exact unknown agent id", async () => {
    const handler = cronHandlers["cron.add"];
    const fakeId = "agent-xyz-999";
    const opts = makeHandlerOptions({ ...BASE_JOB_CREATE, agentId: fakeId });

    await handler(opts);

    const [, , error] = mockRespond.mock.lastCall ?? [];
    expect(error.message).toBe(`agent "${fakeId}" is not configured`);
  });
});

// ---------------------------------------------------------------------------
// Tests — cron.update
// ---------------------------------------------------------------------------

describe("cron.update — agentId validation (PR #60606)", () => {
  function makeUpdateOptions(patch: Record<string, unknown>, jobId = "job-123") {
    return makeHandlerOptions({ id: jobId, patch });
  }

  it("returns INVALID_REQUEST when agentId refers to an unconfigured agent", async () => {
    const handler = cronHandlers["cron.update"];
    const opts = makeUpdateOptions({ ...BASE_PATCH, agentId: UNKNOWN_AGENT_ID });

    await handler(opts);

    expect(mockRespond).toHaveBeenCalledOnce();
    const [ok, payload, error] = mockRespond.mock.lastCall ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(error.message).toContain(UNKNOWN_AGENT_ID);
    expect(mockCronUpdate).not.toHaveBeenCalled();
  });

  it("does NOT call isConfiguredAgent when agentId is null", async () => {
    const handler = cronHandlers["cron.update"];
    const opts = makeUpdateOptions({ ...BASE_PATCH, agentId: null });

    await handler(opts);

    expect(mockIsConfiguredAgent).not.toHaveBeenCalled();
    expect(mockCronUpdate).toHaveBeenCalledOnce();
    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "job-123" }),
      undefined,
    );
  });

  it("does NOT call isConfiguredAgent when agentId is absent", async () => {
    const handler = cronHandlers["cron.update"];
    const opts = makeUpdateOptions(BASE_PATCH); // no agentId field

    await handler(opts);

    expect(mockIsConfiguredAgent).not.toHaveBeenCalled();
    expect(mockCronUpdate).toHaveBeenCalledOnce();
  });

  it("updates the job successfully when agentId is a configured agent", async () => {
    const handler = cronHandlers["cron.update"];
    const opts = makeUpdateOptions({ ...BASE_PATCH, agentId: VALID_AGENT_ID });

    await handler(opts);

    expect(mockIsConfiguredAgent).toHaveBeenCalledWith(expect.anything(), VALID_AGENT_ID);
    expect(mockCronUpdate).toHaveBeenCalledWith(
      "job-123",
      expect.objectContaining({ agentId: VALID_AGENT_ID }),
    );
    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "job-123" }),
      undefined,
    );
  });

  it("error message includes the exact unknown agent id", async () => {
    const handler = cronHandlers["cron.update"];
    const fakeId = "agent-abc-555";
    const opts = makeUpdateOptions({ agentId: fakeId });

    await handler(opts);

    const [, , error] = mockRespond.mock.lastCall ?? [];
    expect(error.message).toBe(`agent "${fakeId}" is not configured`);
  });
});
