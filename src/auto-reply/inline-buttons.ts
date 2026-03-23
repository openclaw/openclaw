type InlineKeyboardButton = { text: string; callback_data: string };

type InlineKeyboardRows = InlineKeyboardButton[][];

const STRUCTURED_INLINE_BUTTON_SURFACES = new Set(["telegram", "poros"]);

export function supportsStructuredInlineButtonsSurface(surface?: string): boolean {
  return normalizeStructuredInlineButtonsSurface(surface) !== null;
}

export function buildStructuredInlineButtonsChannelData(
  buttons: InlineKeyboardRows,
  surface?: string,
): Record<string, { buttons: InlineKeyboardRows }> | undefined {
  const normalizedSurface = normalizeStructuredInlineButtonsSurface(surface);
  if (!normalizedSurface || buttons.length === 0) {
    return undefined;
  }
  return {
    [normalizedSurface]: { buttons },
  };
}

function normalizeStructuredInlineButtonsSurface(surface?: string): string | null {
  const normalized = surface?.trim().toLowerCase();
  if (!normalized || !STRUCTURED_INLINE_BUTTON_SURFACES.has(normalized)) {
    return null;
  }
  return normalized;
}
