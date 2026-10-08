// Shared authoring text for every Workshop writer: the tool description, reviews, and /learn.
export const SKILL_AUTHORING_STANDARDS_PROMPT = [
  "Skill authoring standard:",
  "- A skill is the method for one class of task for this user: ordered steps, each with the exact commands, tools, paths, and the check that shows it worked, then the user's standing preferences for the result.",
  "- Each rule is an imperative plus one clause of why, attached to the step it affects, stated as the behavior to produce. One rule per lesson; a repeated lesson sharpens the existing rule.",
  "- Fix the misleading sentence in place so the skill reads as current truth; leave out update notes, dates, ticket or PR ids, incident stories, and quoted user text.",
  "- Write plain instructions: every sentence should change what the agent does, so drop emphasis and praise.",
  "- description (aim for ≤160 bytes; keep existing triggers when editing): open with the trigger situations, one phrase per distinct case, then what the skill produces. Name the class of work, not today's task.",
  "- Keep in SKILL.md what every run needs; move what only some runs need into references/, templates/, or scripts/ and point to it from the step that needs it.",
].join("\n");

export const SKILL_DO_NOT_CAPTURE_PROMPT = [
  "Do not capture:",
  "- environment-specific or transient failures (missing binaries, unset credentials, flaky network); capture the fix only when it is durable;",
  '- negative claims about tools or features ("X does not work"); they harden into refusals after the cause is fixed;',
  "- unresolved failures or guesses: only a method that visibly worked;",
  "- one-off tasks, personal facts, secrets, or generic advice without concrete commands, paths, or ids.",
].join("\n");
