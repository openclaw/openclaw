// Shared authoring text for every Workshop writer: the tool description, reviews, and /learn.
export const SKILL_AUTHORING_STANDARDS_PROMPT = [
  "Skill authoring standard:",
  "- A skill is a procedure, not memory: the method for one class of task this user repeats, so the next run starts from what worked instead of working it out again. Write ordered steps, each with the exact commands, tools, paths, and the check that shows it worked, then the user's standing preferences for the result. Facts about the user, people, or the world with no method attached belong in memory, not a skill.",
  "- Each rule is an imperative plus one clause of why, attached to the step it affects, stated as the behavior to produce. One rule per lesson; a repeated lesson sharpens the existing rule.",
  "- Fix the misleading sentence in place so the skill reads as current truth; leave out update notes, dates, ticket or PR ids, incident stories, and quoted user text.",
  "- Write plain instructions: every sentence should change what the agent does, so drop emphasis and praise.",
  "- description (aim for ≤160 bytes; keep existing triggers when editing): open with the trigger situations, one phrase per distinct case, then what the skill produces. Name the class of work, not today's task.",
  "- Keep in SKILL.md what every run needs; move what only some runs need into references/, templates/, or scripts/ and point to it from the step that needs it.",
].join("\n");

/** What counts as a skill lesson and how it lands; shared by background review and /learn. */
export const SKILL_LEARNING_METHOD_PROMPT = [
  "Change a skill only for a repeatable procedure: a class of task this user will ask for again, where the next run on a different request of that class would go wrong or redo work without the change. Evidence: the user corrected the method; a non-obvious method worked after trial and error; a skill you used had a wrong, missing, or outdated step. Facts true of only one request (one product, order, menu, date, place, or booking) stay out of skills.",
  "Each skill covers one class of task: sharpen the step a lesson changes in the skill for its class, or create one focused skill when no skill covers that class. Give an unrelated class its own skill rather than a new branch in an existing one. When two listed skills cover the same class, merge them: patch the survivor, then archive the other with absorbed_into. Every change must alter what the agent does next time; keep the skill short by replacing stale lines rather than appending.",
].join("\n");

export const SKILL_DO_NOT_CAPTURE_PROMPT = [
  "Do not capture:",
  "- environment-specific or transient failures (missing binaries, unset credentials, flaky network); capture the fix only when it is durable;",
  '- negative claims about tools or features ("X does not work"); they harden into refusals after the cause is fixed;',
  "- unresolved failures or guesses: only a method that visibly worked;",
  "- knowledge about one codebase (its conventions, build and test commands, architecture, bug fixes): it belongs in that repository's docs or AGENTS.md, where every agent working there reads it;",
  "- one-off tasks, personal facts, secrets, or generic advice without concrete commands, paths, or ids.",
].join("\n");
