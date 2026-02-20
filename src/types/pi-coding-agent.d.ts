import "@mariozechner/pi-coding-agent";

declare module "@mariozechner/pi-coding-agent" {
  interface CreateAgentSessionOptions {
    /** Extra extension paths merged with settings-based discovery. */
    additionalExtensionPaths?: string[];
  }
}
