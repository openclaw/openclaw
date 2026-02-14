import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme/theme.js";

function splitThinkingPrefix(text: string) {
  const markerMatch = text.match(/^\[thinking\]\n([\s\S]*?)\n\[thinking_end\](?:\n\n([\s\S]*))?$/);
  if (markerMatch) {
    return {
      thinking: (markerMatch[1] ?? "").trim(),
      content: (markerMatch[2] ?? "").trim(),
    };
  }

  // Backward-compat for older history entries without [thinking_end].
  const legacyMatch = text.match(/^\[thinking\]\n([\s\S]*?)(?:\n\n([\s\S]*))?$/);
  if (!legacyMatch) {
    return { thinking: "", content: text };
  }
  return {
    thinking: (legacyMatch[1] ?? "").trim(),
    content: (legacyMatch[2] ?? "").trim(),
  };
}

function normalizeThinkingForUi(text: string) {
  return text.replace(/\*\*/g, "").replace(/^\s*\*\s*/gm, "").replace(/\s+/g, " ").trim();
}

function compactThinkingForUi(text: string) {
  const normalized = normalizeThinkingForUi(text);
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
  const lastSentence = parts.length > 0 ? parts[parts.length - 1] : normalized;
  if (lastSentence.length <= 88) {
    return lastSentence;
  }
  return `${lastSentence.slice(0, 87)}…`;
}

let thinkingExpandedView = false;
export function setThinkingExpandedView(value: boolean) {
  thinkingExpandedView = value;
}

export class AssistantMessageComponent extends Container {
  private thinking: Text;
  private body: Markdown;

  constructor(text: string) {
    super();
    this.thinking = new Text("", 1, 0);
    this.body = new Markdown("", 1, 0, markdownTheme, {
      color: (line) => theme.fg(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.thinking);
    this.addChild(this.body);
    this.setText(text);
  }

  setText(text: string) {
    const { thinking, content } = splitThinkingPrefix(text);
    if (thinking) {
      const normalized = normalizeThinkingForUi(thinking);
      const shown = thinkingExpandedView ? normalized : compactThinkingForUi(normalized);
      this.thinking.setText(theme.dim(theme.italic(`thinking ... ${shown || normalized}`)));
    } else {
      this.thinking.setText("");
    }
    this.body.setText(content || (thinking ? "" : text));
  }
}
