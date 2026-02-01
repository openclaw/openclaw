import "@mariozechner/pi-coding-agent";

declare module "@mariozechner/pi-coding-agent" {
  interface CreateAgentSessionOptions {
    /** Extra extension paths merged with settings-based discovery. */
    additionalExtensionPaths?: string[];
    /** Override the default system prompt. */
    systemPrompt?: (defaultPrompt?: string) => string;
    /** Pre-loaded skills. */
    skills?: Skill[];
    /** Pre-loaded context files. */
    contextFiles?: Array<{ path: string; content: string }>;
  }
}
