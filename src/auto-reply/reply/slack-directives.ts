import { parseSlackBlocksInput } from "../../../extensions/slack/src/blocks-input.js";
import { truncateSlackText } from "../../../extensions/slack/src/truncate.js";
import type { ReplyPayload } from "../types.js";

const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";
const SLACK_MAX_BLOCKS = 50;
const SLACK_BUTTON_MAX_ITEMS = 5;
const SLACK_SELECT_MAX_ITEMS = 100;
const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_PLAIN_TEXT_MAX = 75;
const SLACK_OPTION_VALUE_MAX = 75;
const SLACK_DIRECTIVE_RE = /\[\[(slack_buttons|slack_select):\s*([^\]]+)\]\]/gi;

type SlackBlock = Record<string, unknown>;
type SlackChannelData = {
  blocks?: unknown;
};

type SlackChoice = {
  label: string;
  value: string;
};

function parseChoice(raw: string): SlackChoice | null {
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
  const value = trimmed.slice(delimiter + 1).trim();
  if (!label || !value) {
    return null;
  }
  return { label, value };
}

function parseChoices(raw: string, maxItems: number): SlackChoice[] {
  return raw
    .split(",")
    .map((entry) => parseChoice(entry))
    .filter((entry): entry is SlackChoice => Boolean(entry))
    .slice(0, maxItems);
}

function buildSlackReplyChoiceToken(value: string, index: number): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return truncateSlackText(`reply_${index}_${slug || "choice"}`, SLACK_OPTION_VALUE_MAX);
}

function buildSectionBlock(text: string): SlackBlock | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateSlackText(trimmed, SLACK_SECTION_TEXT_MAX),
    },
  };
}

function buildButtonsBlock(raw: string, index: number): SlackBlock | null {
  const choices = parseChoices(raw, SLACK_BUTTON_MAX_ITEMS);
  if (choices.length === 0) {
    return null;
  }
  return {
    type: "actions",
    block_id: `openclaw_reply_buttons_${index}`,
    elements: choices.map((choice, choiceIndex) => ({
      type: "button",
      action_id: `${SLACK_REPLY_BUTTON_ACTION_ID}:${index}_${choiceIndex}`,
      text: {
        type: "plain_text",
        text: truncateSlackText(choice.label, SLACK_PLAIN_TEXT_MAX),
        emoji: true,
      },
      value: buildSlackReplyChoiceToken(choice.value, choiceIndex + 1),
    })),
  };
}

function buildSelectBlock(raw: string, index: number): SlackBlock | null {
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
    type: "actions",
    block_id: `openclaw_reply_select_${index}`,
    elements: [
      {
        type: "static_select",
        action_id: `${SLACK_REPLY_SELECT_ACTION_ID}:${index}`,
        placeholder: {
          type: "plain_text",
          text: truncateSlackText(placeholder, SLACK_PLAIN_TEXT_MAX),
          emoji: true,
        },
        options: choices.map((choice, choiceIndex) => ({
          text: {
            type: "plain_text",
            text: truncateSlackText(choice.label, SLACK_PLAIN_TEXT_MAX),
            emoji: true,
          },
          value: buildSlackReplyChoiceToken(choice.value, choiceIndex + 1),
        })),
      },
    ],
  };
}

function readExistingSlackBlocks(payload: ReplyPayload): SlackBlock[] {
  const slackData = payload.channelData?.slack as SlackChannelData | undefined;
  try {
    const blocks = parseSlackBlocksInput(slackData?.blocks) as SlackBlock[] | undefined;
    return blocks ?? [];
  } catch {
    return [];
  }
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

  const generatedBlocks: SlackBlock[] = [];
  const visibleTextParts: string[] = [];
  let buttonIndex = 0;
  let selectIndex = 0;
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
    const section = buildSectionBlock(precedingText);
    if (section) {
      generatedBlocks.push(section);
    }
    const block =
      directiveType.toLowerCase() === "slack_buttons"
        ? buildButtonsBlock(body, ++buttonIndex)
        : buildSelectBlock(body, ++selectIndex);
    if (block) {
      generatedInteractiveBlock = true;
      generatedBlocks.push(block);
    }
    cursor = index + matchText.length;
  }

  const trailingText = text.slice(cursor);
  visibleTextParts.push(trailingText);
  const trailingSection = buildSectionBlock(trailingText);
  if (trailingSection) {
    generatedBlocks.push(trailingSection);
  }
  const cleanedText = visibleTextParts.join("");

  if (!matchedDirective || !generatedInteractiveBlock) {
    return payload;
  }

  const existingBlocks = readExistingSlackBlocks(payload);
  if (existingBlocks.length + generatedBlocks.length > SLACK_MAX_BLOCKS) {
    return payload;
  }
  const nextBlocks = [...existingBlocks, ...generatedBlocks];

  return {
    ...payload,
    text: cleanedText.trim() || undefined,
    channelData: {
      ...payload.channelData,
      slack: {
        ...(payload.channelData?.slack as Record<string, unknown> | undefined),
        blocks: nextBlocks,
      },
    },
  };
}
