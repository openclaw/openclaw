import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";

export function transcriptScope(env: NodeJS.ProcessEnv, sessionId: string, storePath: string) {
  return { agentId: "main", env, sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
}

export function withTranscriptDatabase<T>(
  sessionId: string,
  run: (fixture: {
    state: OpenClawTestState;
    database: ReturnType<typeof openOpenClawAgentDatabase>;
    scope: ReturnType<typeof transcriptScope>;
  }) => Promise<T>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    return run({ state, database, scope: transcriptScope(state.env, sessionId, database.path) });
  });
}
