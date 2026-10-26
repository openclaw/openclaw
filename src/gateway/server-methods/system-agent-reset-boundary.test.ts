import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { SystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "../../system-agent/system-agent.test-helpers.js";
import {
  createSystemAgentTranscriptStore,
  readTranscriptTailAsync,
} from "../../system-agent/transcript-store.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const inferenceFallbackMocks = vi.hoisted(() => ({
  verifySystemAgentInferenceWithFallback: vi.fn(),
}));
const greetingMocks = vi.hoisted(() => ({
  createSystemAgentGreetingCache: () => ({ assertCurrent: () => undefined }),
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  buildSystemAgentGreetingQuestion: vi.fn(() => undefined),
  loadSystemAgentGreetingFacts: vi.fn(() => ({
    updateAvailable: null,
    channelHealth: { available: true, degraded: [] },
    recentExternalEdit: false,
    auditSequence: 0,
  })),
  resolveSystemAgentGreeting: vi.fn(async () => "welcome text"),
}));

vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback:
    inferenceFallbackMocks.verifySystemAgentInferenceWithFallback,
}));
// Keep durable transcript writes real; stub only greeting discovery.
vi.mock("../../system-agent/greeting.js", () => greetingMocks);

const PRE_RESET_TURNS = [
  { role: "user" as const, text: "pre-reset question", at: 1 },
  { role: "assistant" as const, text: "pre-reset answer", at: 2 },
];

const verifiedConfig: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
  auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
};

const client = { connId: "conn-test", connect: { device: { id: "device-test" } } } as GatewayClient;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockReset();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    resetCommandQueueStateForTest();
    cleanup();
  });
});

beforeEach(async () => {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
  inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 10,
    binding: fixture.binding,
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-reset-boundary-"));
  for (const turn of PRE_RESET_TURNS) {
    await createSystemAgentTranscriptStore().appendTurn(turn);
  }
});

function discardableSessions(dispose: () => Promise<void>): Map<string, SystemAgentChatSession> {
  return new Map([
    [
      "s1",
      {
        engine: { dispose },
        welcome: "welcome text",
        lastUsedAt: 1,
        ownerKey: "device:device-test",
      },
    ],
  ]) as unknown as Map<string, SystemAgentChatSession>;
}

async function resetSession(params: {
  sessions: Map<string, SystemAgentChatSession>;
  approvalManager?: { expire: (id: string, reason: string) => void };
}) {
  const respond = vi.fn();
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({
    params: { sessionId: "s1", reset: true },
    client,
    respond,
    context: {
      systemAgentSessions: params.sessions,
      ...(params.approvalManager ? { systemAgentApprovalManager: params.approvalManager } : {}),
    } as unknown as GatewayRequestContext,
  } as never);
  return respond;
}

async function nextSessionSeed() {
  await closeOpenClawStateDatabaseAsync();
  return readTranscriptTailAsync(30, { afterLastReset: true });
}

describe("openclaw.chat reset boundary", () => {
  it.each([
    [
      "inference verification fails",
      () => {
        inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockResolvedValueOnce({
          ok: false,
          status: "unavailable",
          error: "no configured model",
        });
      },
    ],
    [
      "welcome construction fails",
      () => {
        vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview").mockRejectedValue(
          new SystemAgentInferenceUnavailableError("conversation"),
        );
      },
    ],
  ])("keeps the boundary when %s", async (_label, arrangeFailure) => {
    expect(await nextSessionSeed()).toEqual(PRE_RESET_TURNS);
    const dispose = vi.fn(async () => undefined);
    const sessions = discardableSessions(dispose);
    arrangeFailure();
    const respond = await resetSession({ sessions });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(dispose).toHaveBeenCalled();
    expect(sessions.has("s1")).toBe(false);
    expect(await nextSessionSeed()).toEqual([]);
  });

  it("keeps the boundary when the reset had no live session", async () => {
    inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockResolvedValueOnce({
      ok: false,
      status: "unavailable",
      error: "no configured model",
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const respond = await resetSession({ sessions });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(await nextSessionSeed()).toEqual([]);
  });

  it("keeps the boundary when expiring the pending approval throws", async () => {
    const sessions = discardableSessions(async () => undefined);
    const session = expectDefined(sessions.get("s1"), "seeded session test invariant");
    session.pendingApproval = { id: "approval-1" } as SystemAgentChatSession["pendingApproval"];
    const expire = vi.fn(() => {
      throw new Error("approval store unavailable");
    });

    await expect(resetSession({ sessions, approvalManager: { expire } })).rejects.toThrow(
      "approval store unavailable",
    );

    expect(expire).toHaveBeenCalledWith("approval-1", "session-reset");
    expect(sessions.has("s1")).toBe(false);
    expect(await nextSessionSeed()).toEqual([]);
  });

  it("keeps the boundary when disposing the discarded engine rejects", async () => {
    const sessions = discardableSessions(async () => {
      throw new Error("dispose failed");
    });

    await expect(resetSession({ sessions })).rejects.toThrow("dispose failed");

    expect(sessions.has("s1")).toBe(false);
    expect(await nextSessionSeed()).toEqual([]);
  });
});
