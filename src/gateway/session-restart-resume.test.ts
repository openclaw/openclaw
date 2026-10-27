import { expect, it, vi } from "vitest";
import { addSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionPendingInput } from "../config/sessions/session-pending-input-history.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

it("leaves running cron and external-harness sessions with their execution owner", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const cases: Array<{ sessionKey: string; entry?: Partial<SessionEntry> }> = [
      { sessionKey: "agent:main:ordinary-running" },
      { sessionKey: "agent:main:cron:scheduled:run:occurrence" },
      { sessionKey: "agent:main:acp:external" },
      {
        sessionKey: "agent:main:external-acp-binding",
        entry: {
          acp: {
            backend: "fixture",
            agent: "main",
            runtimeSessionName: "external-runtime",
            mode: "persistent",
            state: "running",
            lastActivityAt: 1,
          },
        },
      },
      { sessionKey: "agent:main:external-harness", entry: { modelSelectionLocked: true } },
    ];
    try {
      for (const { sessionKey, entry } of cases) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { sessionId: sessionKey, updatedAt: 1, ...entry },
        );
        const process = createProcessSessionFixture({ id: sessionKey, backgrounded: true });
        process.agentId = "main";
        process.sessionKey = sessionKey;
        process.scopeKey = sessionKey;
        addSession(process);
      }
      await persistRunningSessionsForRestart({ cfg: {} });
      for (const { sessionKey } of cases) {
        const entry = loadExactSessionEntry({ agentId: "main", sessionKey })?.entry;
        expect(entry).toBeDefined();
        expect(entry?.resumeAfterRestart, sessionKey).toEqual(
          sessionKey === "agent:main:ordinary-running"
            ? { queuedInputIds: [], hadBackgroundExec: true }
            : undefined,
        );
      }
    } finally {
      resetProcessRegistryForTests();
    }
  }));

it("settles captured queued sends as failed when the recorded owner's authority is revoked", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "writer",
          definitions: {
            writer: { scopes: ["operator.write"], agents: "*", sessions: { others: "none" } },
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const profile = ensureProfileForEmail("queued-before-revocation@example.test");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:revoked-queued-owner",
      sessionId: "revoked-queued-owner",
    };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    const receipt = await stageSessionPendingInput(target, {
      runId: "queued-before-revocation",
      message: {
        role: "user",
        content: "Accepted before restart",
        timestamp: 1,
        idempotencyKey: "queued-before-revocation:user",
        __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
      },
      assertCurrent() {},
    });
    if (!receipt) {
      throw new Error("Queued fixture input was not admitted");
    }
    const process = createProcessSessionFixture({ id: "revoked-owner-work", backgrounded: true });
    process.agentId = target.agentId;
    process.sessionKey = target.sessionKey;
    process.scopeKey = target.sessionKey;
    addSession(process);
    try {
      await persistRunningSessionsForRestart({ cfg });
      receipt.finish("interrupted");
      await receipt.settled?.();
      setUserProfileRole(profile.id, "reader");
      const warn = vi.fn();
      await resumeMarkedSessions({
        context: createContext([], () => cfg),
        signal: new AbortController().signal,
        log: { warn },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipped restart resume"));
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
      expect(await readSessionPendingInput(target, receipt.inputId)).toMatchObject({
        state: "cancelled",
        message: { content: "Accepted before restart" },
      });
    } finally {
      receipt?.finish("interrupted");
      await receipt?.settled?.();
      resetProcessRegistryForTests();
    }
  }));
