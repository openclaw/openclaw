/**
 * SkillRouter abstraction — core type definitions.
 *
 * Plugins implement `SkillRouter` and register via `registerSkillRouter`.
 * The agent runner calls the configured router before building the LLM request;
 * results are injected as tool results, keeping the system prompt static.
 */

import type { SkillForPrompt } from "./skill-contract.js";

export type SkillRouteContextMessage = {
  role: "user" | "assistant";
  text: string;
};

export type SkillRouteContext = {
  recentMessages: SkillRouteContextMessage[];
};

/**
 * Discriminated union for routing outcomes.
 *
 * - `direct`: single high-confidence match — framework loads SKILL.md directly
 * - `ambiguous`: multiple candidates — framework injects list for LLM/user to choose
 * - `nomatch`: no match — skip skill, LLM handles on its own
 */
export type SkillRouteResult =
  | { mode: "direct"; name: string }
  | { mode: "ambiguous"; candidates: { name: string; score: number }[] }
  | { mode: "nomatch" };

/** Router interface that plugins implement. */
export interface SkillRouter {
  readonly name: string;
  route(
    query: string,
    candidates: SkillForPrompt[],
    ctx?: SkillRouteContext,
  ): Promise<SkillRouteResult>;
}
