import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

export function seedSharingSession(
  sessionKey: string,
  sessionId: string,
  entry: Parameters<typeof upsertSessionEntryCore>[1] = {},
  agentId = "main",
) {
  return upsertSessionEntryCore({ agentId, sessionKey }, { updatedAt: 1, sessionId, ...entry });
}

export function createSharingState(initialize: () => unknown) {
  return (run: Parameters<typeof withOpenClawTestState>[1]) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (state) => {
      await initialize();
      await run(state);
    });
}
