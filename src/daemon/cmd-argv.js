import { splitArgsPreservingQuotes } from "./arg-split.js";
import { assertNoCmdLineBreak } from "./cmd-set.js";
export function quoteCmdScriptArg(value) {
    assertNoCmdLineBreak(value, "Command argument");
    if (!value) {
        return '""';
    }
    const escaped = value.replace(/"/g, '\\"').replace(/%/g, "%%").replace(/!/g, "^!");
    if (!/[ \t"&|<>^()%!]/g.test(value)) {
        return escaped;
    }
    return `"${escaped}"`;
}
export function unescapeCmdScriptArg(value) {
    return value.replace(/\^!/g, "!").replace(/%%/g, "%");
}
export function parseCmdScriptCommandLine(value) {
    // Script renderer escapes quotes (`\"`) and cmd expansions (`%%`, `^!`).
    // Keep all other backslashes literal so Windows drive/UNC paths survive.
    return splitArgsPreservingQuotes(value, { escapeMode: "backslash-quote-only" }).map(unescapeCmdScriptArg);
}
