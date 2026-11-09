import { z } from "zod";
import type { BoardWidgetActionBinding } from "../../packages/gateway-protocol/src/schema/board.js";
import { BOARD_WIDGET_TOOL_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/board.js";
import { BoardValidationError } from "./board-layout.js";

const safeKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u)
  .refine((key) => !["constructor", "prototype", "__proto__"].includes(key));
const bindingsSchema = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
      actionId: z
        .string()
        .min(1)
        .max(BOARD_WIDGET_TOOL_MAX_LENGTH)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._%-]*$/u),
      params: z
        .unknown()
        .refine(
          (value) =>
            typeof value === "object" && value !== null && !Object.hasOwn(value, "__proto__"),
        )
        .pipe(z.record(safeKey, z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))),
    }),
  )
  .max(16);

/** Canonical definitions are approval identity; even narrowing asks for a new decision. */
export function normalizeBoardWidgetActionBindings(value: unknown): BoardWidgetActionBinding[] {
  if (value === undefined) {
    return [];
  }
  const parsed = bindingsSchema.safeParse(value);
  if (
    !parsed.success ||
    new Set(parsed.data.map((item) => item.name)).size !== parsed.data.length ||
    parsed.data.some(
      (item) =>
        Object.keys(item.params).length > 32 ||
        Buffer.byteLength(JSON.stringify(item), "utf8") > 8192,
    )
  ) {
    throw new BoardValidationError(
      "invalid_operation",
      "Invalid named actions: use unique names and fixed scalar target parameters within 8192 bytes",
    );
  }
  for (const item of parsed.data) {
    item.params = Object.fromEntries(
      Object.entries(item.params).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return parsed.data.toSorted((a, b) => (a.name < b.name ? -1 : 1));
}

export function boardWidgetActionParams(
  binding: BoardWidgetActionBinding,
  dynamic: Record<string, unknown>,
): Record<string, unknown> {
  if (
    Object.keys(dynamic).some(
      (key) =>
        Object.hasOwn(binding.params, key) ||
        ["__proto__", "constructor", "prototype"].includes(key),
    )
  ) {
    throw new BoardValidationError(
      "invalid_operation",
      "Named action parameters cannot override the approved target or operation",
    );
  }
  return { ...dynamic, ...binding.params };
}
