import { normalizeOptionalString } from "../shared/string-coerce.js";

export type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";

export type InteractiveReplyButton = {
  label: string;
  value: string;
  style?: InteractiveButtonStyle;
};

export type InteractiveReplyOption = {
  label: string;
  value: string;
};

export type InteractiveReplyTextBlock = {
  type: "text";
  text: string;
};

export type InteractiveReplyButtonsBlock = {
  type: "buttons";
  buttons: InteractiveReplyButton[];
};

export type InteractiveReplySelectBlock = {
  type: "select";
  placeholder?: string;
  options: InteractiveReplyOption[];
};

export type InteractiveReplyBlock =
  | InteractiveReplyTextBlock
  | InteractiveReplyButtonsBlock
  | InteractiveReplySelectBlock;

export type InteractiveReply = {
  blocks: InteractiveReplyBlock[];
};

function normalizeButtonStyle(value: unknown): InteractiveButtonStyle | undefined {
  const style = normalizeOptionalString(value)?.toLowerCase();
  return style === "primary" || style === "secondary" || style === "success" || style === "danger"
    ? style
    : undefined;
}

function normalizeInteractiveButton(raw: unknown): InteractiveReplyButton | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value =
    normalizeOptionalString(record.value) ??
    normalizeOptionalString(record.callbackData) ??
    normalizeOptionalString(record.callback_data);
  if (!label || !value) {
    return undefined;
  }
  return {
    label,
    value,
    style: normalizeButtonStyle(record.style),
  };
}

function normalizeInteractiveOption(raw: unknown): InteractiveReplyOption | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
  const value = normalizeOptionalString(record.value);
  if (!label || !value) {
    return undefined;
  }
  return { label, value };
}

function normalizeInteractiveBlock(raw: unknown): InteractiveReplyBlock | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const type = normalizeOptionalString(record.type)?.toLowerCase();
  if (type === "text") {
    const text = normalizeOptionalString(record.text);
    return text ? { type: "text", text } : undefined;
  }
  if (type === "buttons") {
    const buttons = Array.isArray(record.buttons)
      ? record.buttons
          .map((entry) => normalizeInteractiveButton(entry))
          .filter((entry): entry is InteractiveReplyButton => Boolean(entry))
      : [];
    return buttons.length > 0 ? { type: "buttons", buttons } : undefined;
  }
  if (type === "select") {
    const options = Array.isArray(record.options)
      ? record.options
          .map((entry) => normalizeInteractiveOption(entry))
          .filter((entry): entry is InteractiveReplyOption => Boolean(entry))
      : [];
    return options.length > 0
      ? {
          type: "select",
          placeholder: normalizeOptionalString(record.placeholder),
          options,
        }
      : undefined;
  }
  return undefined;
}

export function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks
        .map((entry) => normalizeInteractiveBlock(entry))
        .filter((entry): entry is InteractiveReplyBlock => Boolean(entry))
    : [];
  return blocks.length > 0 ? { blocks } : undefined;
}

export function hasInteractiveReplyBlocks(value: unknown): value is InteractiveReply {
  return Boolean(normalizeInteractiveReply(value));
}

export function hasReplyChannelData(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0,
  );
}

export function hasReplyContent(params: {
  text?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: ReadonlyArray<string | null | undefined>;
  interactive?: unknown;
  hasChannelData?: boolean;
  extraContent?: boolean;
}): boolean {
  const text = normalizeOptionalString(params.text);
  const mediaUrl = normalizeOptionalString(params.mediaUrl);
  return Boolean(
    text ||
    mediaUrl ||
    params.mediaUrls?.some((entry) => Boolean(normalizeOptionalString(entry))) ||
    hasInteractiveReplyBlocks(params.interactive) ||
    params.hasChannelData ||
    params.extraContent,
  );
}

export function hasReplyPayloadContent(
  payload: {
    text?: string | null;
    mediaUrl?: string | null;
    mediaUrls?: ReadonlyArray<string | null | undefined>;
    interactive?: unknown;
    channelData?: unknown;
  },
  options?: {
    trimText?: boolean;
    hasChannelData?: boolean;
    extraContent?: boolean;
  },
): boolean {
  return hasReplyContent({
    text: options?.trimText ? payload.text?.trim() : payload.text,
    mediaUrl: payload.mediaUrl,
    mediaUrls: payload.mediaUrls,
    interactive: payload.interactive,
    hasChannelData: options?.hasChannelData ?? hasReplyChannelData(payload.channelData),
    extraContent: options?.extraContent,
  });
}

export function resolveInteractiveTextFallback(params: {
  text?: string;
  interactive?: InteractiveReply;
}): string | undefined {
  const text = normalizeOptionalString(params.text);
  if (text) {
    return params.text;
  }
  const interactiveText = (params.interactive?.blocks ?? [])
    .filter((block): block is InteractiveReplyTextBlock => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return interactiveText || params.text;
}
