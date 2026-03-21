import type { ReplyPayload } from "../types.js";

const SLACK_BUTTON_MAX_ITEMS = 5;
const SLACK_SELECT_MAX_ITEMS = 100;
const SLACK_DIRECTIVE_RE = /\[\[(slack_buttons|slack_select):\s*([^\]]+)\]\]/gi;

type SlackChoice = {
  label: string;
  value: string;
  style?: "primary" | "danger";
};

const VALID_BUTTON_STYLES = new Set(["primary", "danger"]);

function parseChoice(raw: string, parseStyle?: boolean): SlackChoice | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const delimiter = trimmed.indexOf(":");
  if (delimiter === -1) {
    return {
      label: trimmed,
      value: trimmed,
    };
  }
  const label = trimmed.slice(0, delimiter).trim();
  const rest = trimmed.slice(delimiter + 1).trim();
  if (!label || !rest) {
    return null;
  }
  // Check for optional style suffix: Label:value:style (buttons only)
  if (parseStyle) {
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const maybestyle = rest.slice(lastColon + 1).trim().toLowerCase();
      if (VALID_BUTTON_STYLES.has(maybestyle)) {
        const value = rest.slice(0, lastColon).trim();
        if (value) {
          return { label, value, style: maybestyle as "primary" | "danger" };
        }
      }
    }
  }
  return { label, value: rest };
}

function parseChoices(raw: string, maxItems: number, parseStyle?: boolean): SlackChoice[] {
  return raw
    .split(",")
    .map((entry) => parseChoice(entry, parseStyle))
    .filter((entry): entry is SlackChoice => Boolean(entry))
    .slice(0, maxItems);
}

function buildTextBlock(
  text: string,
): NonNullable<ReplyPayload["interactive"]>["blocks"][number] | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return { type: "text", text: trimmed };
}

function buildButtonsBlock(
  raw: string,
): NonNullable<ReplyPayload["interactive"]>["blocks"][number] | null {
  const choices = parseChoices(raw, SLACK_BUTTON_MAX_ITEMS, true);
  if (choices.length === 0) {
    return null;
  }
  return {
    type: "buttons",
    buttons: choices.map((choice) => ({
      label: choice.label,
      value: choice.value,
      ...(choice.style ? { style: choice.style } : {}),
    })),
  };
}

function buildSelectBlock(
  raw: string,
): NonNullable<ReplyPayload["interactive"]>["blocks"][number] | null {
  const parts = raw
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const [first, second] = parts;
  const placeholder = parts.length >= 2 ? first : "Choose an option";
  const choices = parseChoices(parts.length >= 2 ? second : first, SLACK_SELECT_MAX_ITEMS);
  if (choices.length === 0) {
    return null;
  }
  return {
    type: "select",
    placeholder,
    options: choices,
  };
}

export function hasSlackDirectives(text: string): boolean {
  SLACK_DIRECTIVE_RE.lastIndex = 0;
  return SLACK_DIRECTIVE_RE.test(text);
}

export function parseSlackDirectives(payload: ReplyPayload): ReplyPayload {
  const text = payload.text;
  if (!text) {
    return payload;
  }

  const generatedBlocks: NonNullable<ReplyPayload["interactive"]>["blocks"] = [];
  const visibleTextParts: string[] = [];
  let cursor = 0;
  let matchedDirective = false;
  let generatedInteractiveBlock = false;
  SLACK_DIRECTIVE_RE.lastIndex = 0;

  for (const match of text.matchAll(SLACK_DIRECTIVE_RE)) {
    matchedDirective = true;
    const matchText = match[0];
    const directiveType = match[1];
    const body = match[2];
    const index = match.index ?? 0;
    const precedingText = text.slice(cursor, index);
    visibleTextParts.push(precedingText);
    const section = buildTextBlock(precedingText);
    if (section) {
      generatedBlocks.push(section);
    }
    const block =
      directiveType.toLowerCase() === "slack_buttons"
        ? buildButtonsBlock(body)
        : buildSelectBlock(body);
    if (block) {
      generatedInteractiveBlock = true;
      generatedBlocks.push(block);
    }
    cursor = index + matchText.length;
  }

  const trailingText = text.slice(cursor);
  visibleTextParts.push(trailingText);
  const trailingSection = buildTextBlock(trailingText);
  if (trailingSection) {
    generatedBlocks.push(trailingSection);
  }
  const cleanedText = visibleTextParts.join("");

  if (!matchedDirective || !generatedInteractiveBlock) {
    return payload;
  }

  return {
    ...payload,
    text: cleanedText.trim() || undefined,
    interactive: {
      blocks: [...(payload.interactive?.blocks ?? []), ...generatedBlocks],
    },
  };
}
