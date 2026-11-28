import type { SystemAgentAssistantTurn } from "./assistant.js";
import { redactSensitiveCommandText } from "./operations-parse.js";

/** In-memory history shared with the host; callers supply sanitized live user turns. */
export class SystemAgentChatHistory {
  private readonly turns: SystemAgentAssistantTurn[] = [];

  get length(): number {
    return this.turns.length;
  }

  appendAssistant(text: string | undefined): void {
    if (text !== undefined) {
      this.turns.push({ role: "assistant", text });
    }
  }

  appendTurn(userText: string, assistantText: string): void {
    this.turns.push({ role: "user", text: userText });
    this.appendAssistant(assistantText || undefined);
  }

  seed(turns: readonly SystemAgentAssistantTurn[]): void {
    this.turns.push(
      ...turns.map((turn) => ({
        ...turn,
        text: turn.role === "user" ? redactSensitiveCommandText(turn.text) : turn.text,
      })),
    );
  }

  since(index: number): SystemAgentAssistantTurn[] {
    return this.turns.slice(index).map(({ role, text }) => ({ role, text }));
  }

  clear(): void {
    this.turns.length = 0;
  }
}
