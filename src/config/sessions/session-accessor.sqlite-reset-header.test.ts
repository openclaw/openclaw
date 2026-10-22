import { expect } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  applySessionEntryLifecycleMutation,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { sessionTests } from "./session-entry-fixture.test-support.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

const test = sessionTests({ prefix: "openclaw-reset-header-", layout: "state-only" });

async function reset(storePath: string, writer: "single" | "batched", sessionKey: string) {
  const entry = { sessionId: "next-custom", updatedAt: 20 };
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
test.for([
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
  async ({ writer, previous, expectedCwd }, { store }) => {
    const {
      database,
      scope: { sessionKey, storePath },
    } = store;
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "custom-window", updatedAt: 10, ...previous },
    );

    await reset(storePath, writer, sessionKey);

    expect(
      SessionManager.open({
        agentId: "main",
        sessionKey,
        sessionId: "custom-window",
        storePath,
      }).getHeader(),
    ).toMatchObject({ version: CURRENT_SESSION_VERSION, cwd: expectedCwd });
    const events: { type?: unknown; version?: unknown; cwd?: unknown }[] = readTranscriptEventRows(
      database,
      "custom-window",
    ).map((row) => JSON.parse(row.eventJson));
    expect(events[0]).toMatchObject({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      cwd: expectedCwd,
    });
    expect(events[1]?.type).toBe("reset");
  },
);
