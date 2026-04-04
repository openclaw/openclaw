import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import type { QueuedMessage } from "../tui-types.js";

function formatLabel(mode: QueuedMessage["mode"]) {
  return mode === "followUp" ? "Follow-up" : "Steer";
}

export class PendingMessagesComponent extends Container {
  private messages: QueuedMessage[] = [];

  setMessages(messages: QueuedMessage[]) {
    this.messages = [...messages];
    this.renderMessages();
  }

  clearMessages() {
    this.messages = [];
    this.renderMessages();
  }

  private renderMessages() {
    this.clear();
    if (this.messages.length === 0) {
      return;
    }

    this.addChild(new Spacer(1));
    for (const message of this.messages) {
      const label = formatLabel(message.mode);
      this.addChild(new Text(theme.dim(`${label}: ${message.text}`), 1, 0));
    }
    this.addChild(new Text(theme.dim("↳ alt+up to restore queued messages"), 1, 0));
  }
}
