export const TEMPLATE_AGENT_OPENING_MESSAGE = [
  "This ordinary conversation was just created from a Template. Your instruction files and active runtime are ready.",
  "Use your workspace instructions and SOUL personality. Give a brief, natural greeting and orientation in your own voice.",
  "The shared installer owns all remaining declared setup. Do not install integrations, create routines, change instructions, or duplicate setup. Tools are unavailable in this opening turn.",
  "Do not claim integrations or schedules are ready: the installer has not confirmed them yet. If useful, mention briefly that setup is continuing while you are here.",
  "Do not ask the user to choose a role or reconfigure the personality already provided by the Template.",
].join("\n\n");

/** One ordinary agent conversation owns bootstrap and the explicitly selected task. */
export function templateAgentSetupMessage(initialPrompt: string): string {
  return [
    "This Template has finished installation. Use your workspace instructions and SOUL personality. Do not repeat work already completed by the shared installer.",
    "First complete BOOTSTRAP.md, if present. Ask any required setup questions and wait for the user's answers; continue bootstrap across replies as needed. Do not skip setup to carry out the selected task.",
    "Once bootstrap is complete, address the initial prompt the user selected below. If bootstrap is already complete or absent, address it now. This is the user's deferred task, not a replacement for bootstrap. Normal tool permissions and approvals still apply.",
    "Selected initial prompt: " + JSON.stringify(initialPrompt),
  ].join("\n\n");
}
