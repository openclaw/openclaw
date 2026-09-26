/** Windows cmd argument quoting and parser mirror used by service tests. */
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { assertNoCmdLineBreak } from "./cmd-set.js";

export function quoteCmdScriptArg(
  value: string,
  options: { delayedExpansion?: boolean } = {},
): string {
  assertNoCmdLineBreak(value, "Command argument");
  if (!value) {
    return '""';
  }
  const quoted = value.replace(/"/g, '\\"').replace(/%/g, "%%");
  const escaped = options.delayedExpansion === false ? quoted : quoted.replace(/!/g, "^!");
  if (!/[ \t"&|<>^()%!]/g.test(value)) {
    return escaped;
  }
  return `"${escaped}"`;
}

export function parseCmdScriptCommandLine(
  value: string,
  options: { delayedExpansion?: boolean } = {},
): string[] {
  // Unmarked shipped scripts retain their `^!` decoding; disabled expansion preserves carets.
  // Keep all other backslashes literal so Windows drive/UNC paths survive.
  return splitArgsPreservingQuotes(value, { escapeMode: "backslash-quote-only" }).map((argument) =>
    (options.delayedExpansion === false ? argument : argument.replace(/\^!/g, "!")).replace(
      /%%/g,
      "%",
    ),
  );
}
