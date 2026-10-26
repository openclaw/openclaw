import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import { ensureSkillSnapshot } from "./session-updates.js";

it("does not keep a deleted first-turn session entry when persisting skills", async () => {
  const env = { OPENCLAW_TEST_FAST: "0" };
  await withOpenClawTestState({ scenario: "minimal", env }, async (state) => {
    const cfg = { plugins: { enabled: false }, skills: { load: { watch: false } } };
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:main";
    const sessionEntry = { sessionId: "deleted-session", updatedAt: 10 };
    const sessionStore = { [sessionKey]: sessionEntry };
    const sessionEntryHandle = createReplySessionEntryHandle({
      sessionKey,
      sessionEntry,
      sessionStore,
    });
    // The caller retained this entry, but the authoritative store has no row.
    const result = await ensureSkillSnapshot({
      agentId: "main",
      cfg,
      sessionEntry,
      sessionEntryHandle,
      sessionStore,
      sessionKey,
      sessionId: sessionEntry.sessionId,
      storePath: state.path("sessions.json"),
      isFirstTurnInSession: true,
      workspaceDir: state.workspaceDir,
    });
    expect(result).toMatchObject({ sessionEntry: undefined, systemSent: false });
    expect(sessionEntryHandle.getCurrent()).toBeUndefined();
    expect(sessionStore[sessionKey]).toBeUndefined();
  });
});
