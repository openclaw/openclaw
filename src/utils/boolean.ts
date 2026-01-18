export type BooleanParseOptions = {
  truthy?: string[];
  falsy?: string[];
};

const DEFAULT_TRUTHY = ["true", "1", "yes", "on"] as const;
const DEFAULT_FALSY = ["false", "0", "no", "off"] as const;

export function parseBooleanValue(
  value: unknown,
  options: BooleanParseOptions = {},
): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  const truthy = options.truthy ?? DEFAULT_TRUTHY;
  const falsy = options.falsy ?? DEFAULT_FALSY;
  const truthySet = new Set<string>(truthy);
  const falsySet = new Set<string>(falsy);
  if (truthySet.has(normalized)) return true;
  if (falsySet.has(normalized)) return false;
  return undefined;
}