import { assertNoCmdLineBreak } from "./cmd-set.js";

function encodeCmdScriptLiterals(value: string, options: { delayedExpansion?: boolean }): string {
  const encoded = value.replace(/%/g, "%%");
  return options.delayedExpansion === false ? encoded : encoded.replace(/!/g, "^!");
}

// CommandLineToArgvW keeps a quote when the preceding backslash run is even.
// Double that run, and emit 2n+1 backslashes before an embedded quote.
function escapeCmdQuotesAndTrailingSlashes(value: string): string {
  let escaped = "";
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      escaped += `${"\\".repeat(slashes * 2 + 1)}"`;
      slashes = 0;
      continue;
    }
    if (slashes > 0) {
      escaped += "\\".repeat(slashes);
      slashes = 0;
    }
    escaped += char;
  }
  if (slashes > 0) {
    escaped += "\\".repeat(slashes * 2);
  }
  return escaped;
}

export function quoteCmdScriptArg(
  value: string,
  options: { delayedExpansion?: boolean } = {},
): string {
  assertNoCmdLineBreak(value, "Command argument");
  if (!value) {
    return '""';
  }
  const escaped = encodeCmdScriptLiterals(value, options);
  if (!/[ \t"&|<>^()%!]/g.test(value)) {
    return escaped;
  }
  return `"${escapeCmdQuotesAndTrailingSlashes(escaped)}"`;
}

function decodeCmdScriptLiterals(value: string): string {
  return value.replace(/\^!/g, "!").replace(/%%/g, "%");
}

export function parseCmdScriptCommandLine(value: string): string[] {
  // An even backslash run leaves the quote as a boundary, including a quote
  // that opens after `=`. An odd run is a literal quote. %% and ^! decode after.
  const args: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) {
        args.push(decodeCmdScriptLiterals(current));
        current = "";
      }
      continue;
    }
    if (char !== '"') {
      current += char;
      continue;
    }
    let slashes = 0;
    while (current.endsWith("\\")) {
      current = current.slice(0, -1);
      slashes += 1;
    }
    if (slashes % 2 === 1) {
      current += `${"\\".repeat((slashes - 1) / 2)}"`;
      continue;
    }
    current += "\\".repeat(slashes / 2);
    quoted = !quoted;
  }
  if (current.length > 0) {
    args.push(decodeCmdScriptLiterals(current));
  }
  return args;
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
        (char === "^" && (!quoted || commandLine[index + 1] === '"'))
      ) {
        return null;
      }
      if (char === "\\") {
        let slashCount = 0;
        let cursor = index;
        while (commandLine[cursor] === "\\") {
          slashCount += 1;
          cursor += 1;
        }
        if (commandLine[cursor] !== '"') {
          index += 1;
          continue;
        }
        // An odd run is still an escaped quote whose boundary is not exact.
        if (slashCount % 2 === 1) {
          return null;
        }
        index = cursor + 1;
        quoted = !quoted;
        continue;
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
