import path from "node:path";
import { expect } from "vitest";
import {
  listSessionParticipantsReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

export async function expectAcpSessionParticipantInput(
  sessionKey: string,
  dispatch: () => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "codex-acp",
      env: state.env,
      sessionKey,
      storePath: path.join(state.sessionsDir("codex-acp"), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "acp-participant-session",
      updatedAt: 1,
    });
    await dispatch();
    await Promise.resolve();
    await runOpenClawAgentWriteAdmission({ agentId: "codex-acp", env: state.env }, () => undefined);
    expect(listSessionParticipantsReadOnly(scope).get(sessionKey)).toHaveLength(1);
  });
}
