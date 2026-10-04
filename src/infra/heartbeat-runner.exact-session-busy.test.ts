import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { replyRunState } from "../auto-reply/reply/reply-run-registry.state.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

async function withHeartbeatFixture(
  isolatedSession: boolean,
  test: (opts: HeartbeatRunOptions, storePath: string) => Promise<void>,
) {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "30m", target: "none", isolatedSession },
        },
      },
      session: { store: storePath },
    };
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "heartbeat-conversation",
      updatedAt: 1_700_000_000_000,
    });
    await test(
      {
        cfg,
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

function countListedRunKeys() {
  let visits = 0;
  const restore = [ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY, replyRunState.activeSessionIdsByKey].map(
    (map) => {
      const descriptor = Object.getOwnPropertyDescriptor(map, "keys");
      const originalKeys = map.keys.bind(map);
      Object.defineProperty(map, "keys", {
        configurable: true,
        value: () => {
          const iterator = originalKeys();
          const originalNext = iterator.next.bind(iterator);
          iterator.next = () => {
            const result = originalNext();
            if (!result.done) {
              visits += 1;
            }
            return result;
          };
          return iterator;
        },
      });
      return () => {
        if (descriptor) {
          Object.defineProperty(map, "keys", descriptor);
        } else {
          Reflect.deleteProperty(map, "keys");
        }
      };
    },
  );
  return {
    visits: () => visits,
    restore: () => {
      for (const restoreKeys of restore) {
        restoreKeys();
      }
    },
  };
}

describe("heartbeat exact-session busy checks", () => {
  afterEach(resetHeartbeatEventsForTest);

  it.each([false, true])(
    "does not enumerate 1000 active runs for isolatedSession=%s",
    async (isolatedSession) => {
      await withHeartbeatFixture(isolatedSession, async (opts, storePath) => {
        const embeddedBefore = new Map(ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY);
        const replyBefore = new Map(replyRunState.activeSessionIdsByKey);
        const scope = { agentId: "main", storePath, sessionKey };
        const entryBefore = loadExactSessionEntry(scope)?.entry;
        expect(entryBefore).toMatchObject({
          sessionId: "heartbeat-conversation",
          updatedAt: 1_700_000_000_000,
        });
        const cleanup: Array<() => void> = [];
        let visits = 0;
        try {
          for (const kind of runKinds) {
            for (let index = 0; index < 500; index += 1) {
              cleanup.push(
                registerRun(kind, `agent:other:${kind}-${index}`, `${kind}-session-${index}`),
              );
            }
          }
          const counter = countListedRunKeys();
          let wake: Awaited<ReturnType<typeof resolveHeartbeatWakeStage>>;
          let prepared: Awaited<ReturnType<typeof prepareHeartbeatRunStage>> | undefined;
          try {
            wake = await resolveHeartbeatWakeStage(opts);
            if (wake.kind === "ready") {
              prepared = await prepareHeartbeatRunStage(wake);
            }
            visits = counter.visits();
          } finally {
            counter.restore();
          }
          expect(wake.kind).toBe("ready");
          expect(prepared?.kind).toBe("ready");
          if (wake.kind !== "ready" || prepared?.kind !== "ready") {
            throw new Error("expected both heartbeat stages to be ready");
          }
          expect(wake.cfg).toBe(opts.cfg);
          expect(wake.preflight.session.entry).toEqual(entryBefore);
          expect(prepared.run).toEqual(
            isolatedSession
              ? { kind: "isolated", sessionKey: isolatedSessionKey, baseSessionKey: sessionKey }
              : { kind: "shared", sessionKey },
          );
          expect(prepared.runSessionKey).toBe(isolatedSession ? isolatedSessionKey : sessionKey);
          expect(prepared.delivery).toMatchObject({ channel: "none", reason: "target-none" });
          expect(prepared.visibility).toEqual({
            showOk: false,
            showAlerts: true,
            useIndicator: true,
          });
          expect(loadExactSessionEntry(scope)?.entry).toEqual(entryBefore);
          const isolatedEntry = loadExactSessionEntry({ ...scope, sessionKey: isolatedSessionKey });
          if (isolatedSession) {
            expect(isolatedEntry?.entry.heartbeatIsolatedBaseSessionKey).toBe(sessionKey);
            expect(isolatedEntry?.entry.sessionId).not.toBe(entryBefore?.sessionId);
          } else {
            expect(isolatedEntry).toBeUndefined();
          }
          expect(ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.size).toBe(embeddedBefore.size + 500);
          expect(replyRunState.activeSessionIdsByKey.size).toBe(replyBefore.size + 500);
          for (let index = 0; index < 500; index += 1) {
            expect(
              ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(`agent:other:embedded-${index}`),
            ).toBe(`embedded-session-${index}`);
            expect(replyRunState.activeSessionIdsByKey.get(`agent:other:reply-${index}`)).toBe(
              `reply-session-${index}`,
            );
            expect(replyRunState.activeRunsByKey.get(`agent:other:reply-${index}`)?.phase).toBe(
              "running",
            );
          }
        } finally {
          for (const close of cleanup.toReversed()) {
            close();
          }
        }
        expect(ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY).toEqual(embeddedBefore);
        expect(replyRunState.activeSessionIdsByKey).toEqual(replyBefore);
        expect(visits).toBe(0);
      });
    },
  );

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
          expect(wake.kind).toBe("ready");
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

  it("retains reply registry membership when the reply predicate is injected", async () => {
    await withHeartbeatFixture(false, async (opts) => {
      const close = registerRun("reply", sessionKey, "indexed-reply");
      try {
        expect(
          await resolveHeartbeatWakeStage({
            ...opts,
            deps: { ...opts.deps, isReplyRunActive: () => false },
          }),
        ).toEqual({ kind: "skipped", reason: "requests-in-flight" });
      } finally {
        close();
      }
    });
  });

  it.each([
    {
      name: "empty list over registered runs",
      isolated: true,
      keys: [],
      registered: true,
      expected: "ready",
    },
    {
      name: "late isolated run",
      isolated: true,
      keys: [],
      lateKeys: [isolatedSessionKey],
      expected: "skipped",
    },
    { name: "exact membership", isolated: false, keys: [sessionKey], expected: "skipped" },
    { name: "untrimmed membership", isolated: false, keys: [` ${sessionKey} `], expected: "ready" },
  ])(
    "keeps injected $name authoritative",
    async ({ isolated, keys: initialKeys, lateKeys, registered, expected }) => {
      await withHeartbeatFixture(isolated, async (opts, storePath) => {
        const close = registered
          ? [
              registerRun("embedded", sessionKey, "injected-main"),
              registerRun("embedded", isolatedSessionKey, "injected-isolated"),
            ]
          : [];
        let keys = initialKeys;
        const list = vi.fn(() => keys);
        try {
          const wake = await resolveHeartbeatWakeStage({
            ...opts,
            sessionKey: isolated ? sessionKey : ` ${sessionKey} `,
            deps: { ...opts.deps, listActiveEmbeddedRunSessionKeys: list },
          });
          if (!isolated) {
            expect(wake.kind).toBe(expected);
            expect(list).toHaveBeenCalledOnce();
            return;
          }
          expect(wake.kind).toBe("ready");
          if (wake.kind !== "ready") {
            throw new Error("expected injected empty list to admit heartbeat");
          }
          const pending = prepareHeartbeatRunStage(wake);
          if (lateKeys) {
            keys = lateKeys;
            expect(await pending).toEqual({ kind: "skipped", reason: "requests-in-flight" });
            expect(
              loadExactSessionEntry({ agentId: "main", storePath, sessionKey: isolatedSessionKey }),
            ).toBeUndefined();
          } else {
            expect((await pending).kind).toBe("ready");
          }
          expect(list).toHaveBeenCalledTimes(2);
        } finally {
          for (const dispose of close.toReversed()) {
            dispose();
          }
        }
      });
    },
  );
});
