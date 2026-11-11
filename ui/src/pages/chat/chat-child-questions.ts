import type { GatewaySessionRow } from "../../api/types.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { isImplicitHomeLinkedRoot } from "../../components/app-sidebar-session-parent.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
  uiConversationMatches,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";

type ChildSessionQuestions = { prompts: QuestionPrompt[]; sources: ReadonlyMap<string, string> };

export type QuestionProjection = ChildSessionQuestions & { revisions: number[] };

export const EMPTY_QUESTION_PROJECTION: QuestionProjection = {
  prompts: [],
  revisions: [],
  sources: new Map(),
};

/**
 * The conversation's own questions followed by its children's, keeping the
 * previous projection while nothing it shows changed. Question records mutate
 * in place; their revisions own transcript-cache invalidation.
 */
export function reuseQuestionProjection(
  previous: QuestionProjection,
  own: QuestionPrompt[],
  asked: ChildSessionQuestions | undefined,
): QuestionProjection {
  const prompts = asked
    ? [...own, ...asked.prompts.filter((prompt) => !own.includes(prompt))]
    : own;
  const unchanged =
    prompts.length === previous.prompts.length &&
    prompts.every(
      (prompt, index) =>
        prompt === previous.prompts[index] &&
        prompt.revision === previous.revisions[index] &&
        asked?.sources.get(prompt.id) === previous.sources.get(prompt.id),
    );
  return unchanged
    ? previous
    : {
        prompts,
        revisions: prompts.map((prompt) => prompt.revision),
        sources: asked?.sources ?? EMPTY_QUESTION_PROJECTION.sources,
      };
}

/**
 * Pending questions asked by the conversation's direct child sessions. A visible
 * spawned session is an ordinary session that can call `ask_user`; without this
 * its question docks only in the child while the parent waits for it to finish.
 * Answered questions stay in the child's own transcript, so only pending ones
 * dock here, and answers still resolve through the child question's id.
 */
export function projectChildSessionQuestions(
  host: UiSessionDefaultsHost,
  parentKey: string | undefined,
  roster: readonly GatewaySessionRow[] | undefined,
  questions: readonly QuestionPrompt[],
): ChildSessionQuestions {
  const prompts: QuestionPrompt[] = [];
  const sources = new Map<string, string>();
  if (!parentKey) {
    return { prompts, sources };
  }
  // The roster can hold seeded rows and the parent itself. Lineage, not sidebar
  // placement, decides: a promoted child still asks for its parent, while the
  // implicit Home link of operator-created roots is not ancestry.
  const children = (roster ?? []).filter(
    (row) =>
      !row.archived &&
      !areUiSessionKeysEquivalent(row.key, parentKey) &&
      areUiSessionKeysEquivalent(resolveUiSessionNavigationParentKey(row), parentKey) &&
      !isImplicitHomeLinkedRoot(row),
  );
  for (const prompt of questions) {
    if (prompt.status !== "pending") {
      continue;
    }
    const child = children.find((row) =>
      uiConversationMatches(host, row.key, prompt.sessionKey, prompt.agentId),
    );
    if (child) {
      prompts.push(prompt);
      sources.set(prompt.id, resolveSessionDisplayName(child.key, child));
    }
  }
  return { prompts, sources };
}
