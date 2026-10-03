import { Type } from "typebox";

export const BOARD_WIDGET_NAME_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";

/** Keeps an optional placement anchor representable when a model materializes every tool field. */
export function optionalBoardWidgetAnchorSchema(description: string) {
  return Type.Optional(
    Type.Union([Type.String({ pattern: BOARD_WIDGET_NAME_PATTERN }), Type.Null()], { description }),
  );
}

/** Treats a provider-produced null string as omission only at board placement call sites. */
export function normalizeOptionalBoardWidgetAnchor(value: string | undefined): string | undefined {
  return value === "null" ? undefined : value;
}
