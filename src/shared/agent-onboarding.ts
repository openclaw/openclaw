/** The creation preview and saved first assistant turn share the same opening. */
export function buildAgentOnboardingGreeting(agentName?: string): string {
  const name = agentName?.trim();
  return name ? `Hi, I’m ${name}. Happy to help.` : "Hi! Happy to help.";
}
