import { advanceConversationLabelRefinement } from "../auto-reply/reply/conversation-label-refinement.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillCommandSpec } from "../skills/types.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { matchesGeneratedSessionTitle } from "./session-title-state.js";
export { readConversationLabelRefinementSource as readDashboardRefinementSource } from "../auto-reply/reply/conversation-label-refinement.js";

export async function claimDashboardTitleRefinement(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
  userMessage: string;
  skillCommands: SkillCommandSpec[];
  commitGuard?: SessionSourceAssertion;
}): Promise<string | undefined> {
  let claimed: string | undefined;
  await patchSessionEntryCore(
    {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey: resolveStoredSessionKeyForAgentStore(params),
    },
    (current) => {
      claimed = undefined;
      const state = current.titleRefinement;
      if (
        current.sessionId !== params.sessionId ||
        !state ||
        state.remainingMessages <= 0 ||
        !matchesGeneratedSessionTitle(current, state.generatedName)
      ) {
        return null;
      }
      const next = advanceConversationLabelRefinement({
        ...params,
        state,
        currentName: current.displayName,
      });
      if (!next) {
        return null;
      }
      // Claim before inference; a failed attempt leaves the existing name and is not retried.
      if (!next.remainingMessages) {
        claimed = state.generatedName;
      }
      return { titleRefinement: next };
    },
    { requireWriteSuccess: true, ...sessionEntryCommitGuardOptions(params.commitGuard) },
  );
  return claimed;
}
