import fs from "node:fs";
import type { HooksConfig } from "../config/types.hooks.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export function resolveHookTokenFromConfig(
  hooks: Pick<HooksConfig, "token" | "tokenFile"> | undefined,
): string {
  const inlineToken = normalizeOptionalString(hooks?.token);
  const tokenFile = normalizeOptionalString(hooks?.tokenFile);
  if (inlineToken && tokenFile) {
    throw new Error("hooks.token and hooks.tokenFile are mutually exclusive");
  }
  if (inlineToken) {
    return inlineToken;
  }
  if (!tokenFile) {
    return "";
  }
  return fs.readFileSync(tokenFile, "utf8").trim();
}
