import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import * as sessionReader from "./session-utils-store-worker.js";

const sessionKey = "agent:main:worker-lifecycle";
const sessionId = "worker-lifecycle-session";
let config: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
// mock-isolation: The isolated fixture owns routing; no operator configuration is read.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => config }));

function holdRecoveryRead(once = false) {
  const release = createDeferred();
  const entered = createDeferred();
  const read = sessionReader.loadGatewaySessionEntryReadOnlyInWorker;
  const held = vi.spyOn(sessionReader, "loadGatewaySessionEntryReadOnlyInWorker");
  const method = once ? "mockImplementationOnce" : "mockImplementation";
  held[method](async (params) => {
    const result = await read(params);
    entered.resolve();
    await release.promise;
    return result;
  });
  return { release, entered, held };
}

function registeredHarness(key = sessionKey) {
  const h = createAgentEventTestHarness();
  h.nodeHasSessionSubscribers.mockReturnValue(false);
  h.register("worker-lifecycle", key, "worker-lifecycle");
  return Object.assign(h, {
    send: (
      stream: AgentEventRuntimePayload["stream"],
      data: AgentEventRuntimePayload["data"],
      seq = 1,
      overrides: Partial<AgentEventRuntimePayload> = {},
    ) => h.handler({ ...event("start", seq), sessionKey: key, stream, data, ...overrides }),
  });
}

function seedSession(env: NodeJS.ProcessEnv) {
  const target = { agentId: "main", sessionKey, env };
  replaceSessionEntrySync(target, { sessionId, updatedAt: 1 });
  return target;
}

function event(phase: "start" | "end", seq = 1): AgentEventRuntimePayload {
  return {
    runId: "worker-lifecycle",
    agentId: "main",
    sessionKey,
    sessionId,
    lifecycleGeneration: "worker-lifecycle-generation",
    stream: "lifecycle",
    seq,
    ts: 2_000,
    data: { phase, startedAt: 1_000, endedAt: phase === "end" ? 2_000 : undefined },
  };
}

it.each(["close", "queued recovery"])("orders worker recovery through %s", async (mode) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    if (mode === "queued recovery") {
      setRuntimeConfigSnapshot(config);
    }
    const target = seedSession(env);
    if (mode === "close") {
      await sessionReader.loadGatewaySessionEntryReadOnlyInWorker({ cfg: config, key: sessionKey });
    }
    const { release, entered, held } = holdRecoveryRead(mode === "queued recovery");
    const h = registeredHarness();
    if (mode === "close") {
      h.toolEventRecipients.add("worker-lifecycle", "tool-client");
    }
    const sql = mode === "close" ? observeHostDataSql() : undefined;
    let closing: Promise<void> | undefined;
    try {
      const starting = h.handler(event("start"));
      if (sql) {
        expect(
          sql.queries.filter((query) => /\bfrom\s+"?session_(?:nodes|participants)\b/i.test(query)),
        ).toEqual([]);
        await entered.promise;
        const tool = h.send("tool", { phase: "start", name: "read" }, 2);
        const text = h.send("assistant", { text: "Complete reply" }, 3);
        const terminal = h.handler(event("end", 4));
        let closed = false;
        closing = h.handler.dispose().then(() => {
          closed = true;
        });
        const refused = h.send("assistant", { text: "Refused" }, 1, { runId: "late-new-run" });
        expect(closed).toBe(false);
        release.resolve();
        await Promise.all([starting, tool, text, terminal, closing, refused]);
        expect(sql.queries).toEqual([]);
        expect(h.agent().map(([, payload]) => payload.seq)).toEqual([1, 3, 4]);
        expect(h.targetedAgent().map(([, payload]) => payload.seq)).toEqual([2]);
        expect(h.chat().at(-1)?.[1]).toMatchObject({
          state: "final",
          message: { content: [{ type: "text", text: "Complete reply" }] },
        });
      } else {
        await awaitGateBeforeSettlement(
          entered.promise,
          Promise.resolve(starting),
          "recovery did not start",
        );
        const queued = h.handler({ ...event("start", 2), lifecycleGeneration: "pre-restart" });
        await replaceSessionEntry(target, {
          sessionId,
          updatedAt: 2_000,
          abortedLastRun: true,
          restartRecoveryRuns: [{ runId: "worker-lifecycle", lifecycleGeneration: "pre-restart" }],
        });
        release.resolve();
        await Promise.all([starting, queued]);
        expect(h.agent().map(([, payload]) => payload.seq)).toEqual([1]);
        expect(held).toHaveBeenCalledTimes(2);
      }
    } finally {
      release.resolve();
      await closing;
      await h.handler.dispose();
      sql?.restore();
      held.mockRestore();
      h.chatRunState.clear();
    }
  });
});

it("rejects an event whose live claim retires during recovery preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    seedSession(env);
    const h = createAgentEventTestHarness();
    const start = event("start");
    const claimId = claimAgentRunContext(
      start.runId,
      { sessionKey, lifecycleGeneration: start.lifecycleGeneration },
      { trackOwner: true },
    );
    try {
      expect(claimId).toBeDefined();
      const pending = h.handler({ ...start, contextClaimId: claimId } as AgentEventRuntimePayload);
      releaseAgentRunContext(start.runId, claimId);
      await pending;
      expect(h.broadcast).not.toHaveBeenCalled();
      expect(h.broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      releaseAgentRunContext(start.runId, claimId);
      await h.handler.dispose();
    }
  });
});

it("delivers an incognito turn's lifecycle and reply with contiguous sequences", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const key = "agent:main:dashboard:incognito-lifecycle";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: key, env },
      { sessionId, updatedAt: 1, incognito: true },
    );
    const h = registeredHarness(key);
    try {
      const outcomes = await Promise.allSettled([
        h.send("run_status", { phase: "queued" }),
        h.handler({ ...event("start", 2), sessionKey: key }),
        h.send("assistant", { text: "Private reply" }, 3),
        h.handler({ ...event("end", 4), sessionKey: key }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
      expect(
        h.agent().map(([, payload]) => [payload.stream, payload.data.phase, payload.seq]),
      ).toEqual([
        ["run_status", "queued", 1],
        ["lifecycle", "start", 2],
        ["assistant", undefined, 3],
        ["lifecycle", "end", 4],
      ]);
      expect(h.chat().at(-1)?.[1]).toMatchObject({
        state: "final",
        message: { content: [{ type: "text", text: "Private reply" }] },
      });
    } finally {
      await h.handler.dispose();
      h.chatRunState.clear();
      memorySessionActorOwners.reset();
    }
  });
});

it("settles accepted direct lifecycle writes through a qualified global alias", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env, writeConfig }) => {
    const priorConfig = config;
    const scope = new AsyncWorkScope();
    const requestedKey = "agent:research:main";
    const target = { agentId: "research", sessionKey: "global", env };
    try {
      config = {
        agents: { ownership: "explicit", entries: { main: {}, research: {} } },
        session: { scope: "global" },
      };
      await writeConfig(config);
      replaceSessionEntrySync(target, { sessionId: "selected-alias", updatedAt: 1 });
      const selected = await sessionReader.loadGatewaySessionEntryReadOnlyInWorker({
        cfg: config,
        key: requestedKey,
      });
      expect(selected).toMatchObject({
        canonicalKey: "global",
        legacyKey: undefined,
        agentId: target.agentId,
      });
      const persistence = scope.track(() =>
        persistGatewaySessionLifecycleEvent({
          sessionKey: requestedKey,
          event: {
            runId: "selected-alias-run",
            sessionId: "selected-alias",
            ts: 1_000,
            data: { phase: "start", startedAt: 1_000 },
          },
        }),
      );
      scope.beginClose();
      await persistence;
      const stored = { ...target, storePath: selected.storePath };
      const saved = loadExactSessionEntryReadOnly(stored)?.entry;
      expect([saved?.lifecycleRunId, saved?.status]).toEqual(["selected-alias-run", undefined]);
      expect(
        loadExactSessionEntryReadOnly({ ...stored, sessionKey: requestedKey }),
      ).toBeUndefined();
    } finally {
      await scope.drain();
      config = priorConfig;
    }
  });
});
