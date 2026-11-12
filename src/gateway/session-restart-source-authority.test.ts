import { expect, it, vi } from "vitest";
import { addSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";
import * as systemTurnAuthority from "./session-system-turn-authority.js";

function seedRestartSession(sessionId: string, entry: Partial<SessionEntry> = {}) {
  const target = { agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId };
  replaceSessionEntrySync(target, { sessionId, updatedAt: 1, ...entry });
  return target;
}
function addRestartProcess(id: string, target: { agentId: string; sessionKey: string }) {
  const process = createProcessSessionFixture({ id, backgrounded: true });
  process.agentId = target.agentId;
  process.sessionKey = target.sessionKey;
  addSession(process);
}

it("requests original recorded custody only at the actual marked restart admission", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const person = ensureProfileForEmail("restart-source-intent@example.test");
    const target = seedRestartSession("restart-source-intent", {
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: person.id },
    });
    await persistGatewaySessionLifecycleEvent({
      sessionKey: target.sessionKey,
      event: {
        runId: "restart-source-run",
        sessionId: target.sessionId,
        ts: Date.now(),
        data: { phase: "start", startedAt: Date.now() },
      },
    });
    addRestartProcess("restart-source-background", target);
    await persistRunningSessionsForRestart({ cfg });
    resetProcessRegistryForTests();
    expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeDefined();
    const context = createContext([], () => cfg);
    const admission = vi
      .spyOn(systemTurnAuthority, "prepareSessionSystemTurnAuthority")
      .mockRejectedValue(new Error("Stop after observing restart admission intent"));
    try {
      await resumeMarkedSessions({
        context,
        signal: new AbortController().signal,
        log: { warn() {} },
      });
      expect(admission).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          preserveRecordedSource: true,
        }),
      );
    } finally {
      admission.mockRestore();
    }
  }));
