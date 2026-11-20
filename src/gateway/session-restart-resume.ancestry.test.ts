import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

it.each(["nested-hidden", "direct-visible"] as const)(
  "resumes only the finished root of a running %s spawned worker",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const profile = ensureGatewayOwnerProfile("Restart owner");
      const root = { agentId: "main", sessionKey: "agent:main:dashboard:root", sessionId: "root" };
      const coordinator = "agent:main:dashboard:coordinator";
      const worker = kind === "nested-hidden" ? "agent:main:subagent:worker" : coordinator;
      replaceSessionEntrySync(root, {
        sessionId: root.sessionId,
        updatedAt: 1,
        status: "done",
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      const children = kind === "nested-hidden" ? [coordinator, worker] : [worker];
      for (const [index, childSessionKey] of children.entries()) {
        const parent = index === 0 ? root.sessionKey : coordinator;
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: childSessionKey },
          {
            sessionId: childSessionKey,
            updatedAt: 1,
            createdVia: "spawn",
            spawnedBy: parent,
            parentSessionKey: parent,
          },
        );
        subagentRuns.set(
          childSessionKey,
          createSubagentRunRecord({
            runId: childSessionKey,
            childSessionKey,
            childAgentId: "main",
            requesterSessionKey: parent,
            requesterAgentId: "main",
            ...(childSessionKey !== worker ? { endedAt: 1 } : {}),
          }),
        );
      }
      const claim = claimAgentRunContext(
        worker,
        { agentId: "main", sessionKey: worker, sessionId: worker },
        { trackOwner: true, ownsContext: true },
      );
      const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
        accepted: Promise.resolve({ ok: true }),
        id: "ancestry-resume",
        settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
        cancel: () => false,
      });
      try {
        await persistRunningSessionsForRestart({ cfg });
        expect(loadExactSessionEntry(root)?.entry.resumeAfterRestart).toEqual({});
        for (const sessionKey of children) {
          expect(
            loadExactSessionEntry({ agentId: "main", sessionKey })?.entry.resumeAfterRestart,
          ).toBeUndefined();
        }
        releaseAgentRunContext(worker, claim);
        for (const sessionKey of children) {
          subagentRuns.delete(sessionKey);
        }
        await resumeMarkedSessions({
          context: createContext([], () => cfg),
          signal: new AbortController().signal,
          log: { warn() {} },
        });
        expect(resume).toHaveBeenCalledTimes(1);
        expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual([
          root.sessionKey,
        ]);
        expect(loadExactSessionEntry(root)?.entry.resumeAfterRestart).toBeUndefined();
      } finally {
        resume.mockRestore();
        releaseAgentRunContext(worker, claim);
        for (const sessionKey of children) {
          subagentRuns.delete(sessionKey);
        }
      }
    }),
);
