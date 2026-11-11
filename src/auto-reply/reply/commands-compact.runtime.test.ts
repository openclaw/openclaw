import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

// mock-isolation: The real session guard is exercised without starting embedded agent execution.
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: vi.fn(),
}));

const { prepareCurrentSessionEntry } = await import("./commands-compact.runtime.js");

it("retains a compaction dispatch guard across metadata writes and revokes it for a new writer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const agentId = "main";
    const sessionKey = "agent:main:manual-compact";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    const entry = {
      sessionId: "compact-session",
      lifecycleRevision: "original",
      activeWriterRunId: "admitted-writer",
      updatedAt: 1,
    };
    await replaceSessionEntry(scope, entry);
    const prepared = await prepareCurrentSessionEntry({ ...scope, expected: entry });
    expect(prepared?.entry).toMatchObject(entry);
    try {
      await replaceSessionEntry(scope, { ...entry, label: "Renamed", updatedAt: 2 });
      expect(() => prepared?.assertCurrent()).not.toThrow();
      await replaceSessionEntry(scope, { ...entry, activeWriterRunId: "new-writer", updatedAt: 3 });
      expect(() => prepared?.assertCurrent()).toThrow("command session changed");
    } finally {
      prepared?.release();
    }
  });
});
