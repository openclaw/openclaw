import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import * as sessionReader from "./session-utils-store-worker.js";

const sessionKey = "agent:main:worker-lifecycle";
let config: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
// mock-isolation: The isolated fixture owns routing; no operator configuration is read.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => config }));

function event(phase: "start" | "end", seq = 1): AgentEventRuntimePayload {
  return {
    runId: "worker-lifecycle",
    agentId: "main",
    sessionKey,
    sessionId: "worker-lifecycle-session",
    lifecycleGeneration: "worker-lifecycle-generation",
    stream: "lifecycle",
    seq,
    ts: 2_000,
    data: { phase, startedAt: 1_000, endedAt: phase === "end" ? 2_000 : undefined },
  };
}

it("reads lifecycle recovery in workers and retains tool/text order through close", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, env },
      { sessionId: "worker-lifecycle-session", updatedAt: 1 },
    );
    await sessionReader.loadGatewaySessionEntryReadOnlyInWorker({ cfg: config, key: sessionKey });
    const release = createDeferred();
    const entered = createDeferred();
    const read = sessionReader.loadGatewaySessionEntryReadOnlyInWorker;
    const held = vi
      .spyOn(sessionReader, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementation(async (params) => {
        const result = await read(params);
        entered.resolve();
        await release.promise;
        return result;
      });
    const h = createAgentEventTestHarness();
    h.nodeHasSessionSubscribers.mockReturnValue(false);
    h.register("worker-lifecycle", sessionKey, "worker-lifecycle");
    h.toolEventRecipients.add("worker-lifecycle", "tool-client");
    const sql = observeHostDataSql();
    let closing: Promise<void> | undefined;
    try {
      const starting = h.handler(event("start"));
      expect(
        sql.queries.filter((query) => /\bfrom\s+"?session_(?:nodes|participants)\b/i.test(query)),
      ).toEqual([]);
      await entered.promise;
      const tool = h.handler({
        ...event("start", 2),
        stream: "tool",
        data: { phase: "start", name: "read" },
      });
      const text = h.handler({
        ...event("start", 3),
        stream: "assistant",
        data: { text: "Complete reply" },
      });
      const terminal = h.handler(event("end", 4));
      let closed = false;
      closing = h.handler.dispose().then(() => {
        closed = true;
      });
      const refused = h.handler({
        ...event("start"),
        runId: "late-new-run",
        stream: "assistant",
        data: { text: "Refused" },
      });
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
    } finally {
      release.resolve();
      await closing;
      await h.handler.dispose();
      sql.restore();
      held.mockRestore();
      h.chatRunState.clear();
    }
  });
});

it("rejects an event whose live claim retires during recovery preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, env },
      { sessionId: "worker-lifecycle-session", updatedAt: 1 },
    );
    const h = createAgentEventTestHarness();
    const start = event("start");
    const claimId = claimAgentRunContext(
      start.runId,
      {
        sessionKey,
        lifecycleGeneration: start.lifecycleGeneration,
      },
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
      expect(loadExactSessionEntryReadOnly(stored)?.entry).toMatchObject({
        lifecycleRunId: "selected-alias-run",
      });
      expect(loadExactSessionEntryReadOnly(stored)?.entry.status).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({ ...stored, sessionKey: requestedKey }),
      ).toBeUndefined();
    } finally {
      await scope.drain();
      config = priorConfig;
    }
  });
});
