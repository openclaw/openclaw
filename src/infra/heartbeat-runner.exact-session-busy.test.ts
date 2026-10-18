import { afterEach, expect, it, vi } from "vitest";
import { ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY as embeddedRuns } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { replyRunState } from "../auto-reply/reply/reply-run-registry.state.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import {
  prepareHeartbeatRunStage,
  resolveHeartbeatWakeStage,
  type HeartbeatRunOptions,
} from "./heartbeat-runner-execution.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

const sessionKey = "agent:main:main";
const isolatedSessionKey = `${sessionKey}:heartbeat`;
const runKinds = ["embedded", "reply"] as const;
const initialEntry = { sessionId: "heartbeat-conversation", updatedAt: 1_700_000_000_000 };
const replyRuns = replyRunState.activeRunsByKey;

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
        deps: { getQueueSize: () => 0 },
      },
      storePath,
    );
  });
}

function registerRun(kind: (typeof runKinds)[number], key: string, sessionId: string) {
  if (kind === "reply") {
    const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
    operation.setPhase("running");
    return () => operation.complete();
  }
  const handle = createEmbeddedRunHandle();
  setActiveEmbeddedRun(sessionId, handle, key);
  return () => clearActiveEmbeddedRun(sessionId, handle, key);
}

function captureReplyRuns() {
  return new Map(
    Array.from(replyRuns, ([key, { sessionId, phase }]) => [key, { sessionId, phase }]),
  );
}

afterEach(resetHeartbeatEventsForTest);

it("does not enumerate 1000 active runs for an isolated session", async () => {
  await withHeartbeatFixture(true, async (opts, storePath) => {
    const embeddedBefore = new Map(embeddedRuns);
    const replyBefore = captureReplyRuns();
    const expectedEmbedded = new Map(embeddedBefore);
    const expectedReply = new Map(replyBefore);
    const scope = { agentId: "main", storePath, sessionKey };
    const entryBefore = loadExactSessionEntry(scope)?.entry;
    expect(entryBefore).toMatchObject(initialEntry);
    const cleanup: Array<() => void> = [];
    try {
      for (const kind of runKinds) {
        for (let index = 0; index < 500; index += 1) {
          cleanup.push(
            registerRun(kind, `agent:other:${kind}-${index}`, `${kind}-session-${index}`),
          );
          if (kind === "embedded") {
            expectedEmbedded.set(`agent:other:${kind}-${index}`, `${kind}-session-${index}`);
          } else {
            expectedReply.set(`agent:other:${kind}-${index}`, {
              sessionId: `${kind}-session-${index}`,
              phase: "running",
            });
          }
        }
      }
      const keySpies = [embeddedRuns, replyRuns].map((map) => vi.spyOn(map, "keys"));
      let wake: Awaited<ReturnType<typeof resolveHeartbeatWakeStage>>;
      let prepared: Awaited<ReturnType<typeof prepareHeartbeatRunStage>> | undefined;
      try {
        wake = await resolveHeartbeatWakeStage(opts);
        if (wake.kind === "ready") {
          prepared = await prepareHeartbeatRunStage(wake);
        }
        for (const spy of keySpies) {
          expect(spy).not.toHaveBeenCalled();
        }
      } finally {
        for (const spy of keySpies) {
          spy.mockRestore();
        }
      }
      if (wake.kind !== "ready" || prepared?.kind !== "ready") {
        throw new Error("expected both heartbeat stages to be ready");
      }
      expect(wake.cfg).toBe(opts.cfg);
      expect(wake.preflight.session.entry).toEqual(entryBefore);
      expect(prepared).toEqual(
        expect.objectContaining({
          run: { kind: "isolated", sessionKey: isolatedSessionKey, baseSessionKey: sessionKey },
          runSessionKey: isolatedSessionKey,
          delivery: expect.objectContaining({ channel: "none", reason: "target-none" }),
          visibility: { showOk: false, showAlerts: true, useIndicator: true },
        }),
      );
      expect(loadExactSessionEntry(scope)?.entry).toEqual(entryBefore);
      const isolatedEntry = loadExactSessionEntry({ ...scope, sessionKey: isolatedSessionKey });
      expect(isolatedEntry?.entry.heartbeatIsolatedBaseSessionKey).toBe(sessionKey);
      expect(isolatedEntry?.entry.sessionId).not.toBe(entryBefore?.sessionId);
      expect(embeddedRuns).toEqual(expectedEmbedded);
      expect(captureReplyRuns()).toEqual(expectedReply);
    } finally {
      for (const close of cleanup.toReversed()) {
        close();
      }
    }
    expect(embeddedRuns).toEqual(embeddedBefore);
    expect(captureReplyRuns()).toEqual(replyBefore);
  });
});

it.each(
  runKinds.flatMap((kind) => [false, true].map((isolatedSession) => ({ kind, isolatedSession }))),
)(
  "sees a late $kind run at the isolated=$isolatedSession fence",
  async ({ kind, isolatedSession }) => {
    await withHeartbeatFixture(isolatedSession, async (opts, storePath) => {
      const key = isolatedSession ? isolatedSessionKey : sessionKey;
      const scope = { agentId: "main", storePath, sessionKey: key };
      const entryBefore = loadExactSessionEntry(scope)?.entry;
      let pending:
        | ReturnType<typeof resolveHeartbeatWakeStage>
        | ReturnType<typeof prepareHeartbeatRunStage>;
      if (isolatedSession) {
        const wake = await resolveHeartbeatWakeStage(opts);
        if (wake.kind !== "ready") {
          throw new Error("expected heartbeat preflight to be ready");
        }
        expect(loadExactSessionEntry(scope)).toBeUndefined();
        pending = prepareHeartbeatRunStage(wake);
      } else {
        pending = resolveHeartbeatWakeStage(opts);
      }
      // Register after the real asynchronous owner yields, before its busy fence.
      const close = registerRun(kind, key, `late-${kind}`);
      try {
        expect(await pending).toEqual({ kind: "skipped", reason: "requests-in-flight" });
        expect(loadExactSessionEntry(scope)?.entry).toEqual(entryBefore);
        if (isolatedSession) {
          expect(loadExactSessionEntry(scope)).toBeUndefined();
        }
        expect(getLastHeartbeatEvent()).toMatchObject({
          status: "skipped",
          reason: "requests-in-flight",
        });
      } finally {
        close();
      }
    });
  },
);
