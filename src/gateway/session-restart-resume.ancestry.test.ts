import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRegistryLog } from "../agents/subagents/registry/subagent-registry-lifecycle-log.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

const { restartInfo } = vi.hoisted(() => ({ restartInfo: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/restart-resume" ? { ...logger, info: restartInfo } : logger;
    },
  };
});

it.each(["nested-hidden", "direct-visible", "finalized-root-bounded-chain"] as const)(
  "resumes only the finished root of a running %s spawned worker",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const profile = ensureGatewayOwnerProfile("Restart owner");
      const root = { agentId: "main", sessionKey: "agent:main:dashboard:root", sessionId: "root" };
      const coordinator = "agent:main:dashboard:coordinator";
      const worker = kind === "direct-visible" ? coordinator : "agent:main:subagent:worker";
      replaceSessionEntrySync(root, {
        sessionId: root.sessionId,
        updatedAt: 1,
        status: "done",
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      const children =
        kind === "finalized-root-bounded-chain"
          ? [coordinator, "agent:main:subagent:middle", worker]
          : kind === "nested-hidden"
            ? [coordinator, worker]
            : [worker];
      for (const [index, childSessionKey] of children.entries()) {
        const parent = index === 0 ? root.sessionKey : children[index - 1]!;
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
        expect(loadExactSessionEntry(root)?.entry.resumeAfterRestart).toEqual({
          queuedInputIds: [],
        });
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

it.each(["delegated", "ordinary"] as const)(
  "keeps chat recovery in its physical store when the same key in another store is %s",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const key = "agent:main:dashboard:retained";
      const parentKey = "agent:main:dashboard:parent";
      const chat = {
        agentId: "main",
        sessionKey: key,
        sessionId: "chat",
        storePath: state.statePath("chat.sqlite"),
      };
      const other = { ...chat, sessionId: "other", storePath: state.statePath("other.sqlite") };
      const parent = { ...other, sessionKey: parentKey, sessionId: "parent" };
      const spawn = { createdVia: "spawn" as const, spawnedBy: parentKey, spawnDepth: 1 };
      replaceSessionEntrySync(chat, { sessionId: chat.sessionId, updatedAt: 1, ...spawn });
      replaceSessionEntrySync(other, {
        sessionId: other.sessionId,
        updatedAt: 1,
        ...(kind === "delegated" ? spawn : {}),
      });
      replaceSessionEntrySync(parent, { sessionId: parent.sessionId, updatedAt: 1 });
      const runId = "other-store-spawn";
      if (kind === "delegated") {
        subagentRuns.set(
          runId,
          createSubagentRunRecord({
            runId,
            childSessionKey: key,
            childAgentId: "main",
            childSessionIdentity: { sessionId: other.sessionId },
            requesterSessionKey: parentKey,
            requesterAgentId: "main",
            requesterStorePath: other.storePath,
          }),
        );
      }
      const rpc = registerChatAbortController({
        ...chat,
        runId: "direct-chat",
        kind: "chat-send",
        timeoutMs: 30_000,
        target: captureSessionTarget({
          ...chat,
          storeScope: chat.storePath,
          physicalStorePath: chat.storePath,
          incarnation: chat.sessionId,
        }),
      });
      try {
        const controllerInput = expectDefined(rpc.entry, "registered chat").input;
        // Admit the other store first: neither its route nor its marker may absorb this chat.
        restartInfo.mockClear();
        await withSessionTurn(other, () =>
          withSessionTurn({ ...chat, controllerInput }, () =>
            persistRunningSessionsForRestart({ cfg }),
          ),
        );
        expect(loadExactSessionEntry(chat)?.entry.resumeAfterRestart).toMatchObject({
          directChat: true,
        });
        expect(loadExactSessionEntry(other)?.entry.resumeAfterRestart).toEqual(
          kind === "delegated" ? undefined : { queuedInputIds: [] },
        );
        expect(loadExactSessionEntry(parent)?.entry.resumeAfterRestart).toEqual(
          kind === "delegated" ? { queuedInputIds: [] } : undefined,
        );
        expect(restartInfo).toHaveBeenCalledExactlyOnceWith(
          'shutdown restart resume: [{"agentId":"main","marked":2,"skipped":0,"reasons":{}}]',
        );
      } finally {
        rpc.cleanup();
        subagentRuns.delete(runId);
      }
    }),
);

it.each([false, true])("isolates failed ancestry (direct owner: %s)", (directOwner) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const profile = ensureGatewayOwnerProfile("Restart owner");
    const roots = ["healthy-first", "broken", "healthy-last"].map((name) => ({
      agentId: "main",
      sessionKey: `agent:main:dashboard:${name}`,
      sessionId: name,
    }));
    const claims = roots.map((root) => {
      replaceSessionEntrySync(root, {
        sessionId: root.sessionId,
        updatedAt: 1,
        status: "done",
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      const worker = `agent:main:subagent:${root.sessionId}`;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: worker },
        {
          sessionId: worker,
          updatedAt: 1,
          createdVia: "spawn",
          spawnedBy: root.sessionKey,
          parentSessionKey: root.sessionKey,
        },
      );
      subagentRuns.set(
        worker,
        createSubagentRunRecord({
          runId: worker,
          childSessionKey: worker,
          childAgentId: "main",
          requesterSessionKey: root.sessionKey,
          requesterAgentId: "main",
        }),
      );
      return {
        worker,
        claim: claimAgentRunContext(
          worker,
          { agentId: "main", ...(directOwner ? { sessionKey: worker, sessionId: worker } : {}) },
          { trackOwner: true, ownsContext: directOwner },
        ),
      };
    });
    const brokenWorker = expectDefined(claims[1], "broken claim").worker;
    const healthyRoots = [
      expectDefined(roots[0], "first root").sessionKey,
      expectDefined(roots[2], "last root").sessionKey,
    ];
    const failure = new Error("ancestry metadata unavailable");
    const read = sessionEntryReads.readSessionEntryReadOnlyInWorker;
    const reads = vi
      .spyOn(sessionEntryReads, "readSessionEntryReadOnlyInWorker")
      .mockImplementation((scope) =>
        scope.sessionKey === brokenWorker ? Promise.reject(failure) : read(scope),
      );
    const warn = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "healthy-root-resume",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    try {
      await persistRunningSessionsForRestart({ cfg });
      expect(roots.map((root) => loadExactSessionEntry(root)?.entry.resumeAfterRestart)).toEqual([
        { queuedInputIds: [] },
        undefined,
        { queuedInputIds: [] },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.any(String), {
        sessionKey: brokenWorker,
        error: failure,
      });
      for (const { worker, claim } of claims) {
        releaseAgentRunContext(worker, claim);
        subagentRuns.delete(worker);
      }
      await resumeMarkedSessions({
        context: createContext([], () => cfg),
        signal: new AbortController().signal,
        log: { warn() {} },
      });
      expect(resume.mock.calls.map(([, options]) => options.sessionKey).toSorted()).toEqual(
        healthyRoots.toSorted(),
      );
      expect(roots.map((root) => loadExactSessionEntry(root)?.entry.resumeAfterRestart)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    } finally {
      reads.mockRestore();
      warn.mockRestore();
      resume.mockRestore();
      for (const { worker, claim } of claims) {
        releaseAgentRunContext(worker, claim);
        subagentRuns.delete(worker);
      }
    }
  }),
);
