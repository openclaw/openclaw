import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

it.each([
  { child: "settled at shutdown", marker: false },
  { child: "still running", marker: true },
])("gives a restart-aborted child $child a fallback resume marker: $marker", ({ child, marker }) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const target = { agentId: "main", sessionKey: "agent:main:subagent:fallback-child" };
    replaceSessionEntrySync(target, { sessionId: "fallback-child", updatedAt: Date.now() });
    const start = Date.now();
    await persistGatewaySessionLifecycleEvent({
      sessionKey: target.sessionKey,
      event: {
        runId: "child-run",
        sessionId: "fallback-child",
        ts: start,
        data: { phase: "start", startedAt: start },
      },
    });
    const row = createSubagentRunRecord({
      runId: "child-run",
      childSessionKey: target.sessionKey,
      requesterSessionKey: "agent:main:main",
      ...(child === "settled at shutdown"
        ? { endedAt: start + 1, outcome: { status: "error", error: "Gateway stopped" } }
        : { startedAt: start }),
    });
    subagentRuns.set(row.runId, row);
    markGatewayRestartDraining();
    try {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: target.sessionKey,
        event: {
          runId: "child-run",
          sessionId: "fallback-child",
          ts: start + 2,
          data: { phase: "end", aborted: true, stopReason: "restart", endedAt: start + 2 },
        },
      });
      // A child whose outcome already went to its requester must not run its task again.
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart !== undefined).toBe(marker);
    } finally {
      resetGatewayWorkAdmission();
      subagentRuns.delete(row.runId);
    }
  }),
);
