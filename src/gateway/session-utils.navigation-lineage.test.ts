import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { useSessionStoreFixture } from "./session-utils.test-support.js";

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

test.each(["idle", "fork", "visible spawn"] as const)(
  "keeps persistent dashboard navigation beyond run retention (%s)",
  async (kind) => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now);
    const parentKey = "agent:main:dashboard:parent";
    const controllerKey = "agent:main:subagent:controller";
    const childKey = "agent:main:dashboard:child";
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
    } else if (kind === "visible spawn") {
      child.spawnedBy = controllerKey;
      child.spawnDepth = 1;
      seedSubagentRunForReadTest({
        runId: "completed-visible-spawn",
        childSessionKey: childKey,
        requesterSessionKey: controllerKey,
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
    expect(find(childKey)?.parentSessionKey).toBe(parentKey);
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
