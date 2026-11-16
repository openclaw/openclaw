import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { prepareRestartCompletionCustody } from "./session-restart-resume-custody.js";
import { prepareRestartStores } from "./session-restart-resume-discovery.js";

it("recovers an owed completion after its requester has already settled", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const person = ensureGatewayOwnerProfile("Restart custody owner");
    const target = {
      agentId: "main",
      physicalAgentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const sessionKey = "agent:main:dashboard:settled-requester";
    const entry = {
      sessionId: "settled-requester",
      lifecycleRevision: "original-revision",
      updatedAt: 1,
      createdActor: { type: "human" as const, source: "profile" as const, id: person.id },
    };
    replaceSessionEntrySync({ ...target, sessionKey }, entry);
    const child = createSubagentRunRecord({
      runId: "owed-completion",
      childSessionKey: "agent:main:subagent:finished-child",
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
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
      const params = {
        context: createContext(),
        signal: new AbortController().signal,
        log: { warn: vi.fn() },
      };
      params.context.resolveGatewayContext = () => params.context;
      const stores = await prepareRestartStores(params, [target]);
      expect(stores?.[0]?.entries.map((row) => row.sessionKey)).toContain(sessionKey);
      await prepareRestartCompletionCustody(params, stores![0]!);
      expect(params.log.warn).not.toHaveBeenCalled();
      expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(false);
    } finally {
      subagentRuns.delete(child.runId);
    }
  }));

it("leaves completions of an archived requester retired", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:archived-requester",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const child = createSubagentRunRecord({
      runId: "archived-child-completion",
      childSessionKey: "agent:main:dashboard:archived-child",
      requesterSessionKey: target.sessionKey,
      requesterAgentId: target.agentId,
      requesterStorePath: target.storePath,
      expectsCompletionMessage: true,
      spawnMode: "session",
      completionTarget: "parent",
      endedAt: 1,
      delivery: { status: "pending" },
    });
    subagentRuns.set(child.runId, child);
    subagentRuns.retireCompletionAuthority(child);
    try {
      await prepareRestartCompletionCustody(
        { context: createContext(), signal: new AbortController().signal, log: { warn: vi.fn() } },
        {
          target: { ...target, physicalAgentId: target.agentId },
          entries: [
            {
              sessionKey: target.sessionKey,
              entry: { sessionId: "s", updatedAt: 1, archivedAt: 2 },
            },
          ],
        },
      );
      expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(true);
      expect(() => subagentRuns.assertCompletionCurrent(child)).toThrow(
        "Subagent completion requester store was retired",
      );
    } finally {
      subagentRuns.delete(child.runId);
    }
  }));
