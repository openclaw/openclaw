import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

describe("SQLite reset boundary transcript header", () => {
  let testState: OpenClawTestState;
  let storePath: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-reset-header-",
      layout: "state-only",
    });
    const tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  function readEvents(sessionId: string): { type?: unknown; version?: unknown; cwd?: unknown }[] {
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite database path");
    }
    const owner = openOpenClawAgentDatabase({
      agentId: target.agentId ?? "main",
      path: target.path,
    });
    return readTranscriptEventRows(owner, sessionId).map((row) => JSON.parse(row.eventJson));
  }

  async function reset(writer: "single" | "batched", sessionKey: string, nextSessionId: string) {
    const entry = { sessionId: nextSessionId, updatedAt: 20 };
    const resetBoundary = {
      context: "clear" as const,
      reason: "new" as const,
      cwd: "/tmp/reset-session-workspace",
    };
    if (writer === "single") {
      await resetSessionEntryLifecycle({
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        resetBoundary,
        buildNextEntry: () => entry,
      });
    } else {
      await applySessionEntryLifecycleMutation({
        storePath,
        upserts: [{ sessionKey, entry, resetBoundary }],
        skipMaintenance: true,
      });
    }
  }

  // The prior session's workspace must survive callers that know only the agent workspace.
  it.each([
    { writer: "single" as const, previous: {}, expectedCwd: "/tmp/reset-session-workspace" },
    {
      writer: "single" as const,
      previous: {
        spawnedWorkspaceDir: "/tmp/custom-session-workspace",
        spawnedCwd: "/tmp/custom-session-workspace/task",
      },
      expectedCwd: "/tmp/custom-session-workspace/task",
    },
    {
      writer: "batched" as const,
      previous: { spawnedWorkspaceDir: "/tmp/custom-projection-workspace" },
      expectedCwd: "/tmp/custom-projection-workspace",
    },
  ])(
    "preserves the prior workspace for a $writer reset",
    async ({ writer, previous, expectedCwd }) => {
      const sessionKey = "agent:main:custom-workspace-reset";
      const conversationLink = {
        url: "https://chat.example.test/thread/123",
        label: "Source Thread",
      };
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "custom-window",
          updatedAt: 10,
          conversationLink,
          ...previous,
        },
      );

      await reset(writer, sessionKey, "next-custom");
      expect(loadSessionEntry({ sessionKey, storePath })?.conversationLink).toEqual(
        conversationLink,
      );

      expect(
        SessionManager.open({
          agentId: "main",
          sessionKey,
          sessionId: "custom-window",
          storePath,
        }).getHeader(),
      ).toMatchObject({ version: CURRENT_SESSION_VERSION, cwd: expectedCwd });
      const events = readEvents("custom-window");
      expect(events[0]).toMatchObject({ type: "session", version: CURRENT_SESSION_VERSION });
      expect(events[0]?.cwd).toBe(expectedCwd);
      expect(events[1]?.type).toBe("reset");
    },
  );
});
