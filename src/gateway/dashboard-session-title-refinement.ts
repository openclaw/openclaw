import {
  buildConversationLabelReassessmentPrompt,
  planConversationLabelUpdate,
  readConversationLabelRefinementSource,
} from "../auto-reply/reply/conversation-label-refinement.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { SkillCommandSpec } from "../skills/types.js";
import { resolveExplicitSessionName, sessionTitleRequests } from "./session-title-state.js";

/** One naming owner for the current Dashboard conversation, including manually edited names. */
export async function maybeReassessDashboardSessionTitle(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  storePath: string;
  userMessage: string;
  messageId?: string;
  skillCommands: SkillCommandSpec[];
  basePrompt: string;
  assertCurrent: () => void;
  commitGuard?: SessionSourceAssertion;
  onTitleStateChanged?: () => void;
  generate: (sourceText: string, prompt: string, currentName: string) => Promise<string | null>;
}): Promise<boolean> {
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  const target = {
    ...scope,
    sessionId: params.sessionId,
    lifecycleRevision: params.lifecycleRevision,
  };
  const pending = sessionTitleRequests.get(target);
  if (pending) {
    await pending.catch(() => false);
    params.assertCurrent();
    return maybeReassessDashboardSessionTitle(params);
  }
  return sessionTitleRequests.run(
    target,
    async () => {
      params.assertCurrent();
      const before = await readSessionEntryReadOnlyInWorker(scope, params.assertCurrent);
      if (
        !before ||
        before.sessionId !== params.sessionId ||
        before.lifecycleRevision !== params.lifecycleRevision
      ) {
        return false;
      }
      const currentName = resolveExplicitSessionName(before);
      const plan = planConversationLabelUpdate({
        state: before.conversationLabelRefinement,
        currentName,
        sessionId: params.sessionId,
        lifecycleRevision: params.lifecycleRevision,
        userMessage: params.userMessage,
        skillCommands: params.skillCommands,
        messageId: params.messageId,
      });
      if (!plan || plan.kind === "initial") {
        return false;
      }
      const persist = async (name?: string) => {
        let committed = false;
        await patchSessionEntryCore(
          scope,
          (current) => {
            // A reset or manual rename during inference wins over the old result.
            if (
              current.sessionId !== params.sessionId ||
              current.lifecycleRevision !== before.lifecycleRevision ||
              current.label !== before.label ||
              current.displayName !== before.displayName
            ) {
              return null;
            }
            committed = true;
            const patch: Partial<InternalSessionEntry> = {
              conversationLabelRefinement: plan.state,
            };
            if (name && name !== currentName) {
              patch.displayName = name;
              if (current.label?.trim()) {
                patch.label = name;
              }
            }
            return patch;
          },
          {
            requireWriteSuccess: true,
            preserveActivity: true,
            ...sessionEntryCommitGuardOptions(() => {
              params.assertCurrent();
              params.commitGuard?.();
            }),
          },
        );
        return committed;
      };
      if (plan.kind === "observe") {
        await persist();
        return false;
      }
      // The sixth-message attempt is one-shot, even if its model call fails.
      // Reset stays pending until a comparison succeeds.
      if (plan.kind === "refine" && !(await persist())) {
        return false;
      }
      const sourceText =
        plan.kind === "refine"
          ? await readConversationLabelRefinementSource(
              { ...scope, sessionId: params.sessionId, sessionEntry: before },
              params.userMessage,
              params.skillCommands,
            )
          : params.userMessage;
      params.assertCurrent();
      const name = await params.generate(
        sourceText,
        buildConversationLabelReassessmentPrompt(currentName ?? "", params.basePrompt),
        currentName ?? "",
      );
      params.assertCurrent();
      if (!name) {
        return false;
      }
      return (await persist(name)) && name !== currentName;
    },
    params.onTitleStateChanged,
  );
}
