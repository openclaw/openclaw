// Shared authoring text for every Workshop writer: the tool description, reviews, and /learn.
export const SKILL_AUTHORING_STANDARDS_PROMPT = [
  "Skill authoring standard:",
  "- A skill is how to do one class of task for this user: ordered steps with the exact commands, tools, paths, and checks that worked, then the user's standing preferences for the result.",
  "- Each rule is an imperative plus one clause of why, attached to the step it affects. One rule per lesson; a repeated lesson strengthens the existing rule.",
  "- Fix the misleading sentence in place; never append UPDATE/NOTE lines or incident narratives. No dates, ticket or PR ids, or quoted user text.",
  "- description (aim for ≤160 bytes; keep existing triggers when editing): trigger phrases and situations first, then what the skill produces. Name the class of work, not today's task.",
  "- Keep SKILL.md short; move sometimes-needed depth into references/, templates/, or scripts/ and point to it from the step that needs it.",
].join("\n");

export const SKILL_DO_NOT_CAPTURE_PROMPT = [
  "Do not capture:",
  "- environment-specific or transient failures (missing binaries, unset credentials, flaky network); capture the fix only when it is durable;",
  '- negative claims about tools or features ("X does not work"); they harden into refusals after the cause is fixed;',
  "- unresolved failures or guesses: only a method that visibly worked;",
  "- one-off tasks, personal facts, secrets, or generic advice without concrete commands, paths, or ids.",
].join("\n");
