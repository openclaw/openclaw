import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

export function registerSessionRolloverLineageTests(
  makeStorePath: (prefix: string) => Promise<string>,
  expectEntryFields: (entry: SessionEntry, expected: Record<string, unknown>) => void,
) {
  it.each([
    {
      name: "ordinary top-level session",
      sessionKey: "agent:main:main",
      spawnedBy: "agent:main:subagent:stale-parent",
      createdVia: "run" as const,
      subagentRole: "leaf" as const,
      subagentControlScope: "none" as const,
      preservesSpawnLineage: false,
    },
    {
      name: "ordinary ACP session with stale lineage",
      sessionKey: "agent:main:acp:ordinary-stale-role",
      spawnedBy: "agent:main:main",
      createdVia: "run" as const,
      subagentRole: "leaf" as const,
      subagentControlScope: "none" as const,
      preservesSpawnLineage: true,
    },
    {
      name: "visible child",
      sessionKey: "agent:main:dashboard:daily-rollover-lineage",
      spawnedBy: "agent:main:main",
      createdVia: "spawn" as const,
      subagentRole: "leaf" as const,
      subagentControlScope: "none" as const,
      preservesSpawnLineage: true,
    },
    {
      name: "real subagent",
      sessionKey: "agent:main:subagent:daily-rollover-lineage",
      spawnedBy: "agent:main:main",
      createdVia: "spawn" as const,
      subagentRole: "leaf" as const,
      subagentControlScope: "none" as const,
      preservesSpawnLineage: true,
    },
  ])("keeps spawned-run lineage only for a $name rollover", async (testCase) => {
    const storePath = await makeStorePath("openclaw-daily-rollover-lineage-");
    const sessionKey = testCase.sessionKey;
    const existingSessionId = "session-before-daily-reset-lineage";
    const staleStartedAt = Date.now() - 48 * 60 * 60 * 1000;
    const spawnLineage = {
      spawnedBy: testCase.spawnedBy,
      spawnedBySenderIsOwner: true,
      spawnedWorkspaceDir: "/tmp/child-workspace",
      spawnedCwd: "/tmp/task-repo",
      spawnDepth: 1,
      ...(testCase.subagentRole ? { subagentRole: testCase.subagentRole } : {}),
      ...(testCase.subagentControlScope
        ? { subagentControlScope: testCase.subagentControlScope }
        : {}),
    };
    const threadProvenance = {
      parentSessionKey: "agent:main:main",
      parentSessionId: "parent-session",
      parentSessionLifecycleRevision: "parent-generation",
      forkedFromParent: true,
      forkSource: {
        sessionKey: "agent:main:root",
        sessionId: "root-transcript-generation",
      },
      createdVia: testCase.createdVia,
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: staleStartedAt - 1_000,
      sandbox: "required",
    } as const;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: staleStartedAt,
        sessionStartedAt: staleStartedAt,
        lastInteractionAt: staleStartedAt,
        ...threadProvenance,
        ...spawnLineage,
      },
    });

    const result = await initSessionState({
      ctx: {
        RawBody: "continue child work",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg: {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionEntry.previousSessionId).toBeUndefined();
    expectEntryFields(result.sessionEntry, threadProvenance);
    if (testCase.preservesSpawnLineage) {
      expectEntryFields(result.sessionEntry, spawnLineage);
    } else {
      for (const field of Object.keys(spawnLineage)) {
        expect(result.sessionEntry).not.toHaveProperty(field);
      }
    }
  });
}
