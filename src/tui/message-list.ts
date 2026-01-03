import crypto from "node:crypto";
import type { DefaultTextStyle, MarkdownTheme } from "@mariozechner/pi-tui";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

type MessageRole = "user" | "system" | "tool";

export class MessageList extends Container {
  private assistantById = new Map<string, Markdown>();

  constructor(
    private markdownTheme: MarkdownTheme,
    private styles: {
      user: DefaultTextStyle;
      assistant: DefaultTextStyle;
      system: DefaultTextStyle;
      tool: DefaultTextStyle;
    },
  ) {
    super();
  }

  clearAll(): void {
    this.assistantById.clear();
    this.clear();
  }

  addSystem(text: string): void {
    this.addMessage("system", text, this.styles.system);
  }

  addTool(text: string): void {
    this.addMessage("tool", text, this.styles.tool);
  }

  addUser(text: string): void {
    this.addMessage("user", text, this.styles.user);
  }

  addAssistant(text: string, id?: string): string {
    const messageId = id ?? crypto.randomUUID();
    const label = new Text(theme.assistant("clawd"), 1, 0);
    const body = new Markdown(
      text,
      1,
      0,
      this.markdownTheme,
      this.styles.assistant,
    );
    const group = new Container();
    group.addChild(label);
    group.addChild(body);
    this.addChild(group);
    this.addChild(new Spacer(1));

    this.assistantById.set(messageId, body);
    return messageId;
  }

  updateAssistant(id: string, text: string): void {
    const component = this.assistantById.get(id);
    if (!component) return;
    component.setText(text);
  }

  private addMessage(
    role: MessageRole,
    text: string,
    style: DefaultTextStyle,
  ) {
    const label = new Text(
      role === "user"
        ? theme.user("you")
        : role === "system"
          ? theme.system("system")
          : theme.dim("tool"),
      1,
      0,
    );
    const body = new Markdown(text, 1, 0, this.markdownTheme, style);
    const group = new Container();
    group.addChild(label);
    group.addChild(body);
    this.addChild(group);
    this.addChild(new Spacer(1));
  }
}
