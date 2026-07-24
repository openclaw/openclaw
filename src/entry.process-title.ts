import { getCommandPathWithRootOptions } from "./cli/argv.js";

/** Resolve the process title before command bootstrap can open runtime state. */
export function resolveEntryProcessTitle(argv: string[]): "openclaw" | "openclaw-hooks" {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "hooks" && secondary === "relay" ? "openclaw-hooks" : "openclaw";
}
