import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionStoreMocks } from "./dispatch-from-config.shared.test-harness.js";

export async function createDispatchVerboseSession(
  sessionKey: string,
  initialLevel: SessionEntry["verboseLevel"],
) {
  const state = await createOpenClawTestState({ label: "dispatch-verbose" });
  try {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = { agentId: "main", sessionKey, storePath: database.path, env: state.env };
    let updatedAt = 0;
    const writeLevel = (verboseLevel: SessionEntry["verboseLevel"]) => {
      const entry = { sessionId: "dispatch-verbose", updatedAt: ++updatedAt, verboseLevel };
      replaceSessionEntrySync(scope, entry);
      sessionStoreMocks.currentEntry = entry;
    };
    sessionStoreMocks.resolveSessionStorePathCore.mockReturnValue(database.path);
    writeLevel(initialLevel);
    return { writeLevel, [Symbol.asyncDispose]: state.cleanup };
  } catch (error) {
    await state.cleanup();
    throw error;
  }
}
