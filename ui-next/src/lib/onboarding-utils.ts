export const ONBOARDING_STEPS = [
  { step: 1, id: "gateway", title: "Connect Gateway", description: "Verify gateway connection" },
  { step: 2, id: "provider", title: "AI Provider", description: "Configure your AI provider" },
  { step: 3, id: "agents", title: "Agents", description: "Set up your agent team" },
  { step: 4, id: "channels", title: "Channels", description: "Connect messaging channels" },
  { step: 5, id: "first-task", title: "First Task", description: "Send your first message" },
  { step: 6, id: "complete", title: "Complete", description: "Review and finish setup" },
] as const;

export const SUGGESTED_PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
  },
  { id: "openai", name: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"] },
  { id: "google", name: "Google", models: ["gemini-2.5-flash", "gemini-2.5-pro"] },
  { id: "ollama", name: "Ollama (Local)", models: [] },
] as const;
