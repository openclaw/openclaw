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

function unescapeCmdScriptArg(value: string): string {
  return value.replace(/\^!/g, "!").replace(/%%/g, "%");
}

export function parseCmdScriptCommandLine(value: string): string[] {
  // Script renderer escapes quotes (`\"`) and cmd expansions (`%%`, `^!`).
  // Keep all other backslashes literal so Windows drive/UNC paths survive.
  return splitArgsPreservingQuotes(value, { escapeMode: "backslash-quote-only" }).map(
    unescapeCmdScriptArg,
  );
}

export function stripTrailingCmdRedirections(commandLine: string): string | null {
  const tokens: { start: number; end: number; redirect?: string }[] = [];
  // Validate the entire command before removing anything. A compound command or
  // uncertain cmd/argv quote boundary must never become exact process-ownership proof.
  for (let index = 0; index < commandLine.length;) {
    if (/[ \t]/.test(commandLine.charAt(index))) {
      index++;
      continue;
    }
    let start = index;
    const operator = commandLine[index];
    if (operator === ">" || operator === "<") {
      const previous = tokens.at(-1);
      if (previous && !previous.redirect && previous.end === index) {
        const word = commandLine.slice(previous.start, previous.end);
        if (/\d$/.test(word)) {
          // A digit attached to an argument can instead be cmd's handle number.
          // Do not guess which bytes of that argument belong to the process.
          if (!/^\d$/.test(word)) {
            return null;
          }
          start = previous.start;
          tokens.pop();
        }
      }
      index++;
      let redirect: "<" | ">" | ">>" | ">&" = operator;
      if (operator === ">" && commandLine[index] === ">") {
        redirect = ">>";
        index++;
      }
      if (redirect === ">" && commandLine[index] === "&") {
        if (!/[0-9]/.test(commandLine[index + 1] ?? "")) {
          return null;
        }
        redirect = ">&";
        index += 2;
      }
      tokens.push({ start, end: index, redirect });
      continue;
    }
    let quoted = false;
    while (index < commandLine.length) {
      const char = commandLine.charAt(index);
      if (
        char === "\r" ||
        char === "\n" ||
        (char === "\\" && commandLine[index + 1] === '"') ||
        (char === "^" && (!quoted || commandLine[index + 1] === '"'))
      ) {
        return null;
      }
      if (char === '"') {
        quoted = !quoted;
      } else if (!quoted) {
        if ("&|()".includes(char)) {
          return null;
        }
        if (/[ \t<>]/.test(char)) {
          break;
        }
      }
      index++;
    }
    if (quoted) {
      return null;
    }
    tokens.push({ start, end: index });
  }

  const firstRedirect = tokens.findIndex((token) => token.redirect !== undefined);
  const firstToken = tokens[firstRedirect];
  if (!firstToken) {
    return commandLine;
  }
  for (let index = firstRedirect; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token?.redirect) {
      return null;
    }
    if (token.redirect === ">&") {
      continue;
    }
    const target = tokens[++index];
    if (!target || target.redirect) {
      return null;
    }
    const value = commandLine.slice(target.start, target.end);
    // Unquoted expansions can introduce filename delimiters and leave extra argv.
    if (
      (value.includes('"') && !/^"[^"]+"$/.test(value)) ||
      (!value.includes('"') && /[,;=%!]/.test(value)) ||
      (token.redirect === "<" && !/^(?:NUL|"NUL")$/i.test(value))
    ) {
      return null;
    }
  }
  // Redirection alone has no executable for the service reader to inspect.
  return commandLine.slice(0, firstToken.start);
}
