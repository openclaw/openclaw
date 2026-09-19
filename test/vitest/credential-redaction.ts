import { inspect, stripVTControlCharacters } from "node:util";

// Hosted logs are public; runner-issued tokens are not GitHub-masked.
const credentialKey =
  /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|AUTHORIZATION|COOKIE|SESSION/iu;
const assignment = /(?<![\w.-])(["']?)([\w.-]+)\1[\t ]*([:=])/gu;
// A diff hunk can retain the entry's key/value rows while omitting its opening bracket.
const entryPair =
  /(?:\[(?:\s|^[+-][\t ]+)*|^[\t ]*(?:[+-][\t ]+)?)(["'])([\w.-]+)\1(?:\s|^[+-][\t ]+)*,(?:\s|^[+-][\t ]+)*(?=["'])/gmu;
const redacted = /^<redacted len=\d+>$/u;
const closingDelimiter: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
const escapedCharacter: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function isQuote(char: string): boolean {
  return char === '"' || char === "'" || char === "`";
}

function quotedEnd(text: string, start: number): number {
  const quote = text.charAt(start);
  let end = start + 1;
  while (end < text.length) {
    if (text.charAt(end) === "\\") {
      end += 2;
    } else if (text.charAt(end++) === quote) {
      break;
    }
  }
  return Math.min(end, text.length);
}

function containerEnd(text: string, start: number): number {
  const closing: string[] = [];
  let end = start;
  while (end < text.length) {
    const char = text.charAt(end);
    if (isQuote(char)) {
      end = quotedEnd(text, end);
      continue;
    }
    end += 1;
    const close = closingDelimiter[char];
    if (close) {
      closing.push(close);
    } else if (char === closing.at(-1)) {
      closing.pop();
      if (!closing.length) {
        break;
      }
    }
  }
  return end;
}

function isObjectField(text: string, stop: number): boolean {
  const closing: string[] = [];
  for (let index = 0; index < stop; index += 1) {
    const char = text.charAt(index);
    if (isQuote(char)) {
      index = quotedEnd(text, index) - 1;
      continue;
    }
    const close = closingDelimiter[char];
    if (close) {
      closing.push(close);
    } else if (char === closing.at(-1)) {
      closing.pop();
    }
  }
  return closing.at(-1) === "}" || closing.at(-1) === "]";
}

function lineEnd(text: string, start: number): number {
  const newline = text.slice(start).search(/[\r\n]/u);
  return newline < 0 ? text.length : start + newline;
}

function isSourceLocation(text: string, match: RegExpExecArray): boolean {
  if (match[1] || !/^[\w.-]+\.(?:[cm]?[jt]s|[jt]sx):$/u.test(match[0])) {
    return false;
  }
  const start = text.lastIndexOf("\n", match.index - 1) + 1;
  const prefix = text.slice(start, match.index);
  const suffix = text.slice(match.index + match[0].length, lineEnd(text, match.index));
  // Only the filename's coordinate colon is exempt, never another assignment in the frame.
  if (/^\d+:\d+[\t ]*$/u.test(suffix)) {
    return /^[\t ]*(?:at[\t ]+(?:async[\t ]+)?|\u276f[\t ]+(?:[^\r\n]*[\t ]+)?)(?:[^\r\n]*[\\/])?$/u.test(
      prefix,
    );
  }
  return (
    /^\d+:\d+\)[\t ]*$/u.test(suffix) &&
    /^[\t ]*at[\t ]+[^\r\n]+\((?:[^\r\n]*[\\/])?$/u.test(prefix)
  );
}

function bareFieldEnd(text: string, start: number, object: boolean): number {
  let end = start;
  while (end < text.length && !/[\r\n]/u.test(text.charAt(end))) {
    const char = text.charAt(end);
    if (object && /[,}\]]/u.test(char)) {
      break;
    }
    if (isQuote(char) || (object && char === "/")) {
      end = quotedEnd(text, end);
    } else if (closingDelimiter[char]) {
      end = containerEnd(text, end);
    } else {
      end += 1;
    }
  }
  return end;
}

function quotedValue(text: string, start: number): { end: number; value: string } {
  let end = quotedEnd(text, start);
  let value = decodeQuotedValue(text.slice(start, end));
  for (;;) {
    // Node inspection joins multiline strings with + and prefixes diff rows with +/-.
    const continuation = /^[\t ]*\+[\t ]*(?:\r?\n[\t ]*(?:[+-][\t ]+)?)?/u.exec(text.slice(end));
    const next = end + (continuation?.[0].length ?? 0);
    if (!continuation || !isQuote(text.charAt(next))) {
      return { end, value };
    }
    end = quotedEnd(text, next);
    value += decodeQuotedValue(text.slice(next, end));
  }
}

function decodeQuotedValue(value: string): string {
  const body = value.slice(1, value.endsWith(value.charAt(0)) ? -1 : undefined);
  return body.replace(/\\(?:u[\da-f]{4}|x[\da-f]{2}|\r?\n|[\s\S])/giu, (escape) => {
    if (escape[1] === "u" || escape[1] === "x") {
      return String.fromCharCode(Number.parseInt(escape.slice(2), 16));
    }
    const char = escape.charAt(1);
    return char === "\r" || char === "\n" ? "" : (escapedCharacter[char] ?? char);
  });
}

function* quotedValues(text: string) {
  for (let start = 0; start < text.length; start += 1) {
    const char = text.charAt(start);
    if (!isQuote(char) || (char === "'" && /\w/u.test(text.charAt(start - 1)))) {
      continue;
    }
    const quoted = quotedValue(text, start);
    yield { start, ...quoted };
    start = quoted.end - 1;
  }
}

function redactQuotedContent(text: string): string {
  let output = "";
  let consumed = 0;
  for (const quoted of quotedValues(text)) {
    const clean = redactCredentialText(quoted.value);
    if (clean !== quoted.value) {
      output += text.slice(consumed, quoted.start) + JSON.stringify(clean);
      consumed = quoted.end;
    }
  }
  return output + text.slice(consumed);
}

function redactEntryPairs(text: string): string {
  const quotes = [...quotedValues(text)];
  let output = "";
  let consumed = 0;
  for (const match of text.matchAll(entryPair)) {
    if (
      match.index < consumed ||
      !credentialKey.test(match[2] ?? "") ||
      quotes.some((quoted) => match.index > quoted.start && match.index < quoted.end)
    ) {
      continue;
    }
    const start = match.index + match[0].length;
    const quoted = quotedValue(text, start);
    if (redacted.test(quoted.value)) {
      continue;
    }
    const quote = text.charAt(start);
    output += `${text.slice(consumed, start)}${quote}<redacted len=${quoted.value.length}>${quote}`;
    consumed = quoted.end;
  }
  return output + text.slice(consumed);
}

export function redactCredentialText(text: string): string {
  const uncolored = stripVTControlCharacters(text);
  if (!credentialKey.test(uncolored)) {
    return text;
  }
  const plain = uncolored;
  const quotes = [...quotedValues(plain)];
  let output = "";
  let consumed = 0;
  for (const match of plain.matchAll(assignment)) {
    // Embedded strings are redacted after outer fields, without consuming their encoding.
    if (
      match.index < consumed ||
      !credentialKey.test(match[0]) ||
      quotes.some((quoted) => match.index > quoted.start && match.index < quoted.end) ||
      isSourceLocation(plain, match)
    ) {
      continue;
    }
    let start = match.index + match[0].length;
    const environment = match[3] === "=";
    if (!environment) {
      while (/\s/u.test(plain.charAt(start))) {
        start += 1;
      }
    }
    const quote = plain.charAt(start);
    const quoted = isQuote(quote) ? quotedValue(plain, start) : undefined;
    let end =
      quoted?.end ??
      (environment
        ? lineEnd(plain, start)
        : closingDelimiter[quote]
          ? containerEnd(plain, start)
          : bareFieldEnd(plain, start, isObjectField(plain, match.index)));
    let wrapped = quoted !== undefined;
    if (environment && quoted) {
      const rest = lineEnd(plain, end);
      if (plain.slice(end, rest).trim()) {
        end = rest;
        wrapped = false;
      }
    }
    if (!environment) {
      while (end > start && /[\t ]/u.test(plain.charAt(end - 1))) {
        end -= 1;
      }
    }
    const value = plain.slice(start, end);
    if (redacted.test(wrapped ? value.slice(1, -1) : value)) {
      continue;
    }
    const length = wrapped && quoted ? quoted.value.length : value.length;
    output += `${plain.slice(consumed, start)}${wrapped ? quote : ""}<redacted len=${length}>${wrapped ? quote : ""}`;
    consumed = end;
  }
  return redactQuotedContent(redactEntryPairs(output + plain.slice(consumed)));
}

export function redactDiagnostic(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactCredentialText(value);
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  const entryKey: unknown = Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, "0")?.value
    : undefined;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.writable) {
      continue;
    }
    const content: unknown = descriptor.value;
    const credential =
      credentialKey.test(key) ||
      (key === "1" &&
        typeof entryKey === "string" &&
        credentialKey.test(entryKey) &&
        typeof content === "string");
    const replacement =
      credential && !(typeof content === "string" && redacted.test(content))
        ? `<redacted len=${typeof content === "string" ? content.length : inspect(content, { customInspect: false, getters: false }).length}>`
        : redactDiagnostic(content, seen);
    Reflect.set(value, key, replacement);
  }
  return value;
}
