import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { prepareSessionsSendCommunication } from "../agents/tools/sessions-send-communication.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { seedSessionEntries, useSessionStoreFixture } from "./session-utils.test-support.js";

const storePath = useSessionStoreFixture("session-navigation-retention-");
const cfg = { session: { mainKey: "main" }, agents: { entries: { main: {} } } };
const now = Date.UTC(2026, 8, 26, 12);
const old = now - 2 * 60 * 60_000;
beforeEach(async () => {
  resetAgentEventsForTest({ preserveListeners: true });
  await resetSubagentRegistryForTests({ persist: false });
  setRuntimeConfigSnapshot(cfg);
});
afterEach(async () => {
  resetAgentEventsForTest({ preserveListeners: true });
  await resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
});

test.each(["idle", "fork", "visible spawn", "native spawn", "legacy native spawn"] as const)(
  "keeps durable parent navigation beyond run retention (%s)",
  async (kind) => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now);
    const parentKey = "agent:main:dashboard:parent";
    const controllerKey = "agent:main:subagent:controller";
    const native = kind === "native spawn" || kind === "legacy native spawn";
    const childKey = native ? "agent:main:subagent:child" : "agent:main:dashboard:child";
    const child: SessionEntry = {
      sessionId: "child",
      updatedAt: kind === "fork" ? now - 1_000 : old,
      parentSessionKey: parentKey,
      parentSessionId: "parent",
    };
    if (kind === "fork") {
      child.status = "done";
      child.endedAt = old;
      child.forkSource = { sessionKey: parentKey, sessionId: "parent" };
    } else if (kind === "visible spawn" || native) {
      child.spawnedBy = native ? parentKey : controllerKey;
      if (kind === "legacy native spawn") {
        delete child.parentSessionKey;
      }
      child.spawnDepth = 1;
      seedSubagentRunForReadTest({
        runId: "completed-visible-spawn",
        childSessionKey: childKey,
        requesterSessionKey: native ? parentKey : controllerKey,
        requesterDisplayKey: "controller",
        createdAt: old - 2_000,
        startedAt: old - 1_000,
        endedAt: old,
        outcome: { status: "ok" },
      });
    }
    const store = {
      [parentKey]: { sessionId: "parent", updatedAt: now },
      [controllerKey]: { sessionId: "controller", updatedAt: now },
      [childKey]: child,
    };
    const list = (spawnedBy?: string) =>
      listSessionFixture({ cfg, storePath: storePath(), store, opts: { spawnedBy } });
    const all = await list();
    const find = (key: string) => all.sessions.find((row) => row.key === key);
    if (kind !== "legacy native spawn") {
      expect(find(childKey)?.parentSessionKey).toBe(parentKey);
    }
    expect(find(parentKey)?.childSessions).toEqual([childKey]);
    expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);
    // Navigation persists without retaining runtime delegation ownership.
    expect(find(controllerKey)?.childSessions).toBeUndefined();
    expect((await list(controllerKey)).sessions).toEqual([]);
    child.archivedAt = now;
    expect((await list(parentKey)).sessions).toEqual([]);
    delete child.archivedAt;
    expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);
  },
);

test.each(["explicit", "legacy"] as const)(
  "preserves %s lineage without stealing a verified active controller",
  async (kind) => {
    const parent = "agent:main:dashboard:parent";
    const controller = "agent:main:dashboard:controller";
    const child = "agent:main:subagent:child";
    const childEntry: SessionEntry = {
      sessionId: "child",
      lifecycleRevision: "child-life",
      updatedAt: old,
      spawnedBy: parent,
      parentSessionId: "parent",
      ...(kind === "explicit" ? { parentSessionKey: parent } : {}),
    };
    const store = {
      [parent]: { sessionId: "parent", updatedAt: now },
      [controller]: { sessionId: "controller", updatedAt: now },
      [child]: childEntry,
    };
    const runId = "foreign-active-controller";
    const foreignRun = {
      runId,
      childSessionKey: child,
      controllerSessionKey: controller,
      requesterSessionKey: controller,
      requesterDisplayKey: "controller",
      childSessionIdentity: { sessionId: "child", lifecycleRevision: "child-life" },
      createdAt: now,
      startedAt: now,
    };
    seedSubagentRunForReadTest(foreignRun);
    const list = (spawnedBy: string) =>
      listSessionFixture({ cfg, storePath: storePath(), store, opts: { spawnedBy } });
    expect((await list(controller)).sessions).toEqual([]);
    expect((await list(parent)).sessions.map((row) => row.key)).toEqual([child]);
    const claim = claimAgentRunContext(
      runId,
      { sessionKey: child, sessionId: "child" },
      { trackOwner: true },
    );
    expect(claim).toBeDefined();
    try {
      expect((await list(parent)).sessions.map((row) => row.key)).toEqual(
        kind === "explicit" ? [child] : [],
      );
      expect((await list(controller)).sessions.map((row) => row.key)).toEqual([child]);
      seedSessionEntries(storePath(), store);
      const send = () =>
        prepareSessionsSendCommunication({
          config: cfg,
          message: "Continue",
          source: {
            agentId: "main",
            sessionKey: parent,
            storePath: storePath(),
            entry: store[parent],
          },
          target: { agentId: "main", sessionKey: child, storePath: storePath(), entry: childEntry },
          callGateway: vi.fn(),
        });
      await expect(send()).rejects.toThrow("controlled by another active session");
      // Cancellation is not a transfer: the foreign executor still occupies the child.
      seedSubagentRunForReadTest({
        ...foreignRun,
        killIntent: { requestedAt: now, reason: "cancel" },
      });
      await expect(send()).rejects.toThrow("controlled by another active session");
      seedSubagentRunForReadTest({
        ...foreignRun,
        endedAt: now,
      });
      // A terminal row cannot confer control even while executor cleanup retains its claim.
      expect((await list(controller)).sessions).toEqual([]);
      expect((await list(parent)).sessions.map((row) => row.key)).toEqual([child]);
    } finally {
      if (claim) {
        releaseAgentRunContext(runId, claim);
      }
    }
    // A process-local row without its execution claim is only historical data.
    expect((await list(controller)).sessions).toEqual([]);
    expect((await list(parent)).sessions.map((row) => row.key)).toEqual([child]);
  },
);
