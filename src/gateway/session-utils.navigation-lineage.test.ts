/** Tests persisted navigation lineage independently of live subagent control. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { listSessionFixture } from "./session-list.test-support.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("session list navigation lineage", () => {
  afterEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await closeOpenClawStateDatabaseAsync();
    resetSubagentRegistryForTests({ persist: false });
  });
  beforeEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    resetSubagentRegistryForTests({ persist: false });
  });

  const cfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  test("keeps persisted navigation lineage separate from live registry control", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:controlled-child";
    const entry = {
      sessionId: "sess-controlled-child",
      updatedAt: now,
      spawnedBy: "agent:main:subagent:persisted-spawner",
      parentSessionKey: "agent:main:dashboard:navigation-parent",
      parentSessionId: "sess-navigation-parent",
      createdVia: "spawn",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: now - 10_000,
      forkSource: {
        sessionKey: "agent:main:main",
        sessionId: "sess-source",
        entryId: "entry-source",
      },
      previousSessionId: "sess-previous",
    } satisfies SessionEntry;

    addSubagentRunForTests({
      runId: "run-controlled-child",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:runtime-controller",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "controlled child",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
    });

    const result = await listSessionFixture({
      cfg,
      storePath: "/tmp/sessions.json",
      store: { [childSessionKey]: entry },
      opts: {},
    });
    const row = expectDefined(result.sessions[0], "controlled child row");

    expect(row.spawnedBy).toBe("agent:main:subagent:runtime-controller");
    expect(row.controlOwnerSessionKey).toBe("agent:main:subagent:runtime-controller");
    expect(row.parentSessionKey).toBe("agent:main:dashboard:navigation-parent");
    expect(row.parentSessionId).toBe("sess-navigation-parent");
    expect(row.createdVia).toBe("spawn");
    expect(row.createdActor).toEqual({
      type: "agent",
      id: "agent:main:main",
      identity: { type: "agent", id: "agent:main:main" },
    });
    expect(row.createdAt).toBe(now - 10_000);
    expect(row.forkSource).toEqual({
      sessionKey: "agent:main:main",
      sessionId: "sess-source",
      entryId: "entry-source",
    });
    expect(row.previousSessionId).toBe("sess-previous");

    const homeLinkedResult = await listSessionFixture({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": { sessionId: "sess-home", updatedAt: now - 1 },
        "agent:main:dashboard:conversation": {
          sessionId: "sess-conversation",
          updatedAt: now,
          parentSessionKey: "agent:main:main",
        },
      },
      opts: {},
    });
    const homeLinkedRow = expectDefined(
      homeLinkedResult.sessions.find(
        (session) => session.key === "agent:main:dashboard:conversation",
      ),
      "Home-linked conversation row",
    );
    expect(homeLinkedRow.parentSessionKey).toBe("agent:main:main");
    expect(homeLinkedRow.parentSessionId).toBeUndefined();
  });
});
