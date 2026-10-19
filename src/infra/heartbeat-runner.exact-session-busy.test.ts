import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import {
  prepareHeartbeatRunStage,
  resolveHeartbeatWakeStage,
  type HeartbeatRunOptions,
} from "./heartbeat-runner-execution.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

const sessionKey = "agent:main:main";
const isolatedSessionKey = `${sessionKey}:heartbeat`;
const initialEntry = { sessionId: "heartbeat-conversation", updatedAt: 1_700_000_000_000 };

async function withHeartbeatFixture(
  isolatedSession: boolean,
  test: (opts: HeartbeatRunOptions, storePath: string) => Promise<void>,
) {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
    const heartbeat = { every: "30m", target: "none", isolatedSession };
    await seedSessionStore(storePath, sessionKey, initialEntry);
    await test(
      {
        cfg: {
          agents: { defaults: { workspace: tmpDir, heartbeat } },
          session: { store: storePath },
        },
        agentId: "main",
        sessionKey,
        source: "cron",
        intent: "immediate",
      },
      storePath,
    );
  });
}

function registerTurn(key: string, sessionId: string, storePath: string) {
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId,
    agentId: "main",
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey: key,
      agentId: "main",
      incarnation: sessionId,
    }),
  });
  operation.setPhase("running");
  return operation;
}

afterEach(resetHeartbeatEventsForTest);

it.each([false, true])(
  "leaves unrelated controller turns untouched for isolatedSession=%s",
  async (isolatedSession) => {
    await withHeartbeatFixture(isolatedSession, async (opts, storePath) => {
      const runKey = isolatedSession ? isolatedSessionKey : sessionKey;
      const scope = { agentId: "main", storePath, sessionKey };
      const entryBefore = loadExactSessionEntry(scope)?.entry;
      const operations = [
        registerTurn("agent:main:other", "other-conversation", storePath),
        registerTurn(runKey, "other-store-conversation", path.join(storePath, "other-store")),
      ];
      try {
        const wake = await resolveHeartbeatWakeStage(opts);
        expect(wake.kind).toBe("ready");
        if (wake.kind !== "ready") {
          throw new Error("expected heartbeat preflight to be ready");
        }
        const prepared = await prepareHeartbeatRunStage(wake);
        expect(prepared.kind).toBe("ready");
        if (prepared.kind !== "ready") {
          throw new Error("expected unrelated turns to leave preparation ready");
        }
        expect(prepared.runSessionKey).toBe(runKey);
        expect(prepared.delivery).toMatchObject({ channel: "none", reason: "target-none" });
        expect(loadExactSessionEntry(scope)?.entry).toEqual(entryBefore);
        const isolatedEntry = loadExactSessionEntry({
          ...scope,
          sessionKey: isolatedSessionKey,
        });
        if (isolatedSession) {
          expect(isolatedEntry?.entry.heartbeatIsolatedBaseSessionKey).toBe(sessionKey);
          expect(isolatedEntry?.entry.sessionId).not.toBe(entryBefore?.sessionId);
        } else {
          expect(isolatedEntry).toBeUndefined();
        }
        for (const operation of operations) {
          expect(operation.result).toBeNull();
          expect(operation.abortSignal.aborted).toBe(false);
        }
      } finally {
        for (const operation of operations) {
          operation.complete();
        }
      }
    });
  },
);

it("defers a late isolated turn before creating its session row", async () => {
  await withHeartbeatFixture(true, async (opts, storePath) => {
    const scope = { agentId: "main", storePath, sessionKey: isolatedSessionKey };
    const wake = await resolveHeartbeatWakeStage(opts);
    expect(wake.kind).toBe("ready");
    if (wake.kind !== "ready") {
      throw new Error("expected heartbeat preflight to be ready");
    }
    expect(loadExactSessionEntry(scope)).toBeUndefined();
    const pending = prepareHeartbeatRunStage(wake);
    // Register after the real asynchronous owner yields, before its admission fence.
    const operation = registerTurn(isolatedSessionKey, "late-isolated-turn", storePath);
    try {
      expect(await pending).toEqual({ kind: "skipped", reason: "requests-in-flight" });
      expect(loadExactSessionEntry(scope)).toBeUndefined();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: "requests-in-flight",
      });
      expect(operation.result).toBeNull();
      expect(operation.abortSignal.aborted).toBe(false);
    } finally {
      operation.complete();
    }
  });
});

it("leaves a busy shared session to dispatch admission", async () => {
  await withHeartbeatFixture(false, async (opts, storePath) => {
    const scope = { agentId: "main", storePath, sessionKey };
    const entryBefore = loadExactSessionEntry(scope)?.entry;
    const operation = registerTurn(sessionKey, "heartbeat-conversation", storePath);
    try {
      const wake = await resolveHeartbeatWakeStage(opts);
      expect(wake.kind).toBe("ready");
      if (wake.kind !== "ready") {
        throw new Error("expected shared-session preflight to defer busy handling");
      }
      expect((await prepareHeartbeatRunStage(wake)).kind).toBe("ready");
      expect(loadExactSessionEntry(scope)?.entry).toEqual(entryBefore);
      expect(operation.result).toBeNull();
      expect(operation.abortSignal.aborted).toBe(false);
    } finally {
      operation.complete();
    }
  });
});
