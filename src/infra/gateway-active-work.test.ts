// Canonical Gateway active-work waiting must report the owners that block shutdown.
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { GatewaySuspendPrepareResultSchema } from "../../packages/gateway-protocol/src/index.js";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
} from "./gateway-active-work.js";
import { beginLifecycleWriteCustody } from "./lifecycle-write-custody.js";

const activeRuns = new Map<string, EmbeddedAgentQueueHandle>();

afterEach(() => {
  for (const [sessionId, handle] of activeRuns) {
    clearActiveEmbeddedRun(sessionId, handle);
  }
  activeRuns.clear();
  resetGatewayWorkAdmission();
});

describe("waitForGatewayActiveWork", () => {
  it.each([
    { agentRuns: 1, acpRuns: 0, mediaRuns: 0, kind: "agent-run" },
    { agentRuns: 0, acpRuns: 1, mediaRuns: 0, kind: "acp-run" },
    { agentRuns: 0, acpRuns: 0, mediaRuns: 1, kind: "media-generation" },
  ] as const)(
    "reports native $kind ownership alongside background processes",
    ({ agentRuns, acpRuns, mediaRuns, kind }) => {
      const snapshot = createGatewayActiveWorkSnapshot({
        getQueueSize: () => 0,
        getPendingReplies: () => 0,
        getEmbeddedRuns: () => 0,
        getBackgroundExecSessions: () => 1,
        getCronRuns: () => 0,
        getAgentRuns: () => agentRuns,
        getAcpRuns: () => acpRuns,
        getMediaRuns: () => mediaRuns,
        getRootRequests: () => 0,
        getSessionAdmissions: () => 0,
        getSessionMutations: () => 0,
        getChatRuns: () => 0,
        getQueuedTurns: () => 0,
        getTerminalPersistence: () => 0,
        getTerminalSessions: () => 0,
      });
      expect(snapshot.idle).toBe(false);
      expect(snapshot.counts).toMatchObject({
        backgroundExecSessions: 1,
        agentRuns,
        acpRuns,
        mediaRuns,
        totalActive: 2,
      });
      expect(snapshot.blockers.map((blocker) => blocker.kind)).toEqual(["background-exec", kind]);
      expect(
        Value.Check(GatewaySuspendPrepareResultSchema, {
          status: "draining",
          suspensionId: "held-owner",
          expiresAtMs: 120_000,
          retryAfterMs: 20_000,
          activeCount: snapshot.counts.totalActive,
          blockers: snapshot.blockers,
        }),
      ).toBe(true);
    },
  );

  it("returns the final canonical blockers when its deadline expires", async () => {
    const sessionId = "probe-gateway-active-work-timeout";
    const handle: EmbeddedAgentQueueHandle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    activeRuns.set(sessionId, handle);
    setActiveEmbeddedRun(sessionId, handle);

    const result = await waitForGatewayActiveWork(0);

    expect(result.drained).toBe(false);
    expect(result.snapshot.counts.embeddedRuns).toBe(1);
    expect(result.snapshot.blockers).toContainEqual({
      kind: "embedded-run",
      count: 1,
      message: "1 active embedded run(s)",
    });
  });

  it("names active root request holders in deterministic order", async () => {
    const first = tryBeginGatewayRootWorkAdmission("ws:sessions.subscribe");
    const second = tryBeginGatewayRootWorkAdmission("cron:timer-tick");
    const third = tryBeginGatewayRootWorkAdmission("ws:sessions.subscribe");

    try {
      const result = await waitForGatewayActiveWork(0);

      expect(result.snapshot.blockers).toContainEqual({
        kind: "root-request",
        count: 3,
        message: "3 active gateway request(s): cron:timer-tick, ws:sessions.subscribe (2)",
      });
    } finally {
      first?.release();
      second?.release();
      third?.release();
    }
  });

  it("publishes a separate recorded custody category through the suspension wire shape", () => {
    const release = beginLifecycleWriteCustody("migration");
    try {
      const snapshot = createGatewayActiveWorkSnapshot({
        getRootRequests: () => 2,
        getCronRuns: () => 3,
        getSessionMutations: () => 1,
        getTerminalPersistence: () => 1,
      });
      expect(snapshot.writeCustody).toEqual([
        { phase: "migration", count: 1 },
        { phase: "session-mutation", count: 1 },
        { phase: "terminal-persistence", count: 1 },
      ]);
      expect(snapshot.counts).toMatchObject({ rootRequests: 2, cronRuns: 3, lifecycleWrites: 1 });
      expect(
        Value.Check(GatewaySuspendPrepareResultSchema, {
          status: "draining",
          suspensionId: "owned",
          expiresAtMs: 120_000,
          retryAfterMs: 20_000,
          activeCount: snapshot.counts.totalActive,
          blockers: snapshot.blockers,
          writeCustody: snapshot.writeCustody,
        }),
      ).toBe(true);
    } finally {
      release();
    }
    expect(createGatewayActiveWorkSnapshot().writeCustody).toEqual([]);
  });

  it("does not mix default holders into an overridden root count", () => {
    const admission = tryBeginGatewayRootWorkAdmission("ws:agent");
    try {
      const snapshot = createGatewayActiveWorkSnapshot({ getRootRequests: () => 1 });

      expect(snapshot.blockers).toContainEqual({
        kind: "root-request",
        count: 1,
        message: "1 active gateway request(s)",
      });
    } finally {
      admission?.release();
    }
  });
});
