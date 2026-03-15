import { normalizeOptionalAccountId } from "../routing/account-id.js";

export function normalizeAccountId(value?: string): string | undefined {
  return normalizeOptionalAccountId(value);
}
