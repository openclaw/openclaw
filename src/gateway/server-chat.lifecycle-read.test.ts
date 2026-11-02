import { expect, it, vi } from "vitest";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
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
