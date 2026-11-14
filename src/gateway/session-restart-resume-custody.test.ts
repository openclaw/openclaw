import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { prepareRestartCompletionCustody } from "./session-restart-resume-custody.js";

it.for(["archived", "replaced", "reset"] as const)(
  "does not recover completion custody from a stale %s requester snapshot",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const person = ensureGatewayOwnerProfile("Restart custody owner");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:retired-requester",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const entry: InternalSessionEntry = {
        sessionId: "original-requester",
        lifecycleRevision: "original-revision",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: person.id },
      };
      replaceSessionEntrySync(target, {
        ...entry,
        ...(change === "archived"
          ? { archivedAt: 2 }
          : change === "replaced"
            ? { sessionId: "replacement-requester" }
            : { lifecycleRevision: "reset-revision" }),
      });
      const child = createSubagentRunRecord({
        runId: "retained-child-completion",
        childSessionKey: "agent:main:dashboard:retained-child",
        requesterSessionKey: target.sessionKey,
        requesterAgentId: target.agentId,
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        expectsCompletionMessage: true,
        spawnMode: "session",
        completionTarget: "parent",
        endedAt: 1,
        delivery: { status: "pending" },
      });
      subagentRuns.set(child.runId, child);
      subagentRuns.retireCompletionAuthority(child);
      try {
        const warn = vi.fn();
        await prepareRestartCompletionCustody(
          {
            context: createContext(),
            signal: new AbortController().signal,
            log: { warn },
          },
          {
            target: { ...target, physicalAgentId: target.agentId },
            entries: [{ sessionKey: target.sessionKey, entry }],
          },
        );
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Restart completion recovery failed"),
        );
        expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(true);
        expect(() => subagentRuns.runWithCompletionAuthority(child, () => undefined)).toThrow(
          "Subagent completion requester store was retired",
        );
      } finally {
        subagentRuns.delete(child.runId);
      }
    }),
);
