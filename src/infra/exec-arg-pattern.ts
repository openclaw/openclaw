// Compiles persisted exec argPattern values without changing their exact match semantics.
import { compileSafeRegexDetailed, type SafeRegexRejectReason } from "../security/safe-regex.js";

export type ExecArgPatternRejectReason = Exclude<SafeRegexRejectReason, "empty">;

type ExecArgPatternCompileResult =
  | { regex: RegExp; reason: null }
  | { regex: null; reason: ExecArgPatternRejectReason };

export function compileExecArgPattern(source: string): ExecArgPatternCompileResult {
  const safety = compileSafeRegexDetailed(source);
  if (safety.regex) {
    return { regex: safety.regex, reason: null };
  }
  if (safety.reason !== "empty") {
    return { regex: null, reason: safety.reason };
  }
  // Blank persisted patterns historically compile as JavaScript regexes instead of
  // acting like absent argPattern values.
  try {
    return { regex: new RegExp(source), reason: null };
  } catch {
    return { regex: null, reason: "invalid-regex" };
  }
}
