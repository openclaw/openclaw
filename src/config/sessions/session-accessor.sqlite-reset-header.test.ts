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

test.for([
  ["single", {}, "/tmp/reset-session-workspace"],
  [
    "single",
    { spawnedWorkspaceDir: "/tmp/custom", spawnedCwd: "/tmp/custom/task" },
    "/tmp/custom/task",
  ],
  ["batched", { spawnedWorkspaceDir: "/tmp/custom-projection" }, "/tmp/custom-projection"],
] as const)(
  "preserves the prior workspace for a %s reset",
  async ([writer, previous, cwd], { store }) => {
    const {
      database,
      scope: { sessionKey, storePath },
    } = store;
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "custom-window", updatedAt: 10, ...previous },
    );

    await reset(storePath, writer, sessionKey);

    const expectedHeader = { version: CURRENT_SESSION_VERSION, cwd };
    expect(
      SessionManager.open({
        agentId: "main",
        sessionKey,
        sessionId: "custom-window",
        storePath,
      }).getHeader(),
    ).toMatchObject(expectedHeader);
    const events: { type?: unknown; version?: unknown; cwd?: unknown }[] = readTranscriptEventRows(
      database,
      "custom-window",
    ).map((row) => JSON.parse(row.eventJson));
    expect(events[0]).toMatchObject({ type: "session", ...expectedHeader });
    expect(events[1]?.type).toBe("reset");
  },
);
