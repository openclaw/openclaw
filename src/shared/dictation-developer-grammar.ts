import { findPhrase, matchesPhrase, type DeveloperToken } from "./dictation-developer-lex.ts";
import type {
  DeveloperDiagnostic,
  DeveloperPlanRequest,
  DeveloperProfile,
  DeveloperSymbol,
} from "./dictation-developer-types.ts";

type Piece = {
  text: string;
  kind: "word" | "symbol" | "exact" | "space";
  rawStart?: number;
  rawEnd?: number;
};
type ParsedCommand = { next: number; text: string; diagnostics: DeveloperDiagnostic[] };
type Style = "snakeCase" | "camelCase" | "pascalCase" | "kebabCase";
export type DeveloperSymbolIndex = {
  symbol?: DeveloperSymbol;
  next: Map<string, DeveloperSymbolIndex>;
};

/** One request-local trie; profiles never install a matcher or executable regexp. */
export function indexDeveloperSymbols(symbols: readonly DeveloperSymbol[]): DeveloperSymbolIndex {
  const root: DeveloperSymbolIndex = { next: new Map() };
  for (const symbol of symbols) {
    let node = root;
    for (const word of symbol.spoken.split(" ")) {
      let child = node.next.get(word);
      if (!child) {
        child = { next: new Map() };
        node.next.set(word, child);
      }
      node = child;
    }
    node.symbol = symbol;
  }
  return root;
}

function matchSymbol(
  tokens: readonly DeveloperToken[],
  start: number,
  end: number,
  root: DeveloperSymbolIndex,
) {
  let node = root;
  for (let index = start; index < end && index < start + 8; index++) {
    const token = tokens[index]!;
    const child = !token.quoted ? node.next.get(token.text.toLowerCase()) : undefined;
    if (!child) {
      return undefined;
    }
    if (child.symbol) {
      return { symbol: child.symbol, next: index + 1 };
    }
    node = child;
  }
  return undefined;
}

function diagnostic(
  tokens: readonly DeveloperToken[],
  start: number,
  end: number,
  code: DeveloperDiagnostic["code"],
  message: string,
): DeveloperDiagnostic {
  const first = tokens[start]!;
  return {
    id: `${code}:${first.start}`,
    code,
    severity: "blocking",
    start: first.start,
    end: tokens[Math.max(start, end - 1)]!.end,
    message,
  };
}

function identifier(
  tokens: readonly DeveloperToken[],
  style: Style,
  profile: DeveloperProfile,
): string | undefined {
  if (
    !tokens.length ||
    tokens.some((token) => token.quoted || !/^[\p{L}\p{M}\p{N}_$]+$/u.test(token.text))
  ) {
    return undefined;
  }
  const words = tokens.map((token) => {
    if (profile.acronymPolicy === "preserve" && /^\p{Lu}{2,}\p{N}*$/u.test(token.text)) {
      return { lower: token.text, upper: token.text };
    }
    const lower = token.text.toLocaleLowerCase(profile.locale);
    const first =
      new Intl.Segmenter(profile.locale, { granularity: "grapheme" }).segment(lower).containing(0)
        ?.segment ?? "";
    const upper = first.toLocaleUpperCase(profile.locale) + lower.slice(first.length);
    return { lower, upper };
  });
  if (style === "snakeCase" || style === "kebabCase") {
    return words.map((word) => word.lower).join(style === "snakeCase" ? "_" : "-");
  }
  return words
    .map((word, index) => (style === "camelCase" && index === 0 ? word.lower : word.upper))
    .join("");
}

function spelling(
  tokens: readonly DeveloperToken[],
  profile: DeveloperProfile,
): string | undefined {
  if (!tokens.length) {
    return undefined;
  }
  const output: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const label = token.text.toLowerCase();
    if (label === profile.spelling.digit) {
      const digit = tokens[++index]?.text.toLowerCase();
      const position = profile.spelling.digits.indexOf(digit ?? "");
      if (position < 0) {
        return undefined;
      }
      output.push(String(position));
    } else if (label === profile.spelling.capital || label === profile.spelling.lower) {
      const letter = tokens[++index]?.text;
      if (!letter || !/^\p{L}\p{M}*$/u.test(letter)) {
        return undefined;
      }
      const value =
        label === profile.spelling.capital
          ? letter.toLocaleUpperCase(profile.locale)
          : letter.toLocaleLowerCase(profile.locale);
      // Explicit letter spelling cannot silently expand one character into two.
      if (
        [...new Intl.Segmenter(profile.locale, { granularity: "grapheme" }).segment(value)]
          .length !== 1
      ) {
        return undefined;
      }
      output.push(value);
    } else if (!token.quoted && /^[\p{L}\p{N}]\p{M}*$/u.test(token.text)) {
      output.push(token.text);
    } else {
      return undefined;
    }
  }
  return output.join("");
}

function symbolText(symbol: DeveloperSymbol, profile: DeveloperProfile): string {
  if (symbol.spoken === "quote") {
    return profile.quoteStyle === "single" ? "'" : '"';
  }
  return symbol.spoken === "indent" ? profile.whitespace.indentation : symbol.text;
}

function resolveSymbol(
  symbol: DeveloperSymbol,
  token: DeveloperToken,
  request: DeveloperPlanRequest,
): { text?: string; diagnostic?: DeveloperDiagnostic } {
  if (!symbol.alternatives) {
    return { text: symbolText(symbol, request.profile) };
  }
  const id = `symbol:${token.start}`;
  const choice = request.choices?.[id];
  if (choice !== undefined && symbol.alternatives.some((item) => item.text === choice)) {
    return { text: choice };
  }
  return {
    diagnostic: {
      id,
      code: "ambiguous",
      severity: "blocking",
      start: token.start,
      end: token.end,
      message:
        choice === undefined
          ? "Choose the intended symbol."
          : "The selected symbol is not an advertised alternative.",
      alternatives: symbol.alternatives,
    },
  };
}

/** Spacing applies only to spoken syntax boundaries, never inside exact tokens. */
function renderPieces(pieces: readonly Piece[], profile: DeveloperProfile, source: string): string {
  let result = "";
  let prior: Piece | undefined;
  let quote: string | undefined;
  for (const piece of pieces) {
    if (!piece.text) {
      continue;
    }
    let space = Boolean(prior) && prior?.kind !== "space" && piece.kind !== "space";
    const opening = piece.kind === "symbol" && /^[([{]$/u.test(piece.text);
    const closing = piece.kind === "symbol" && /^[)\]},;:.]$/u.test(piece.text);
    const joiner = piece.kind === "symbol" && /^[\\/_]$/u.test(piece.text);
    if (
      closing ||
      joiner ||
      opening ||
      (prior?.kind === "symbol" && /^[([{.\\/_]$/u.test(prior.text))
    ) {
      space = false;
    }
    if (prior?.kind === "symbol" && prior.text === ",") {
      space = profile.whitespace.commaSpace && !closing;
    }
    if (prior?.kind === "symbol" && prior.text === ":") {
      space = profile.whitespace.colonSpace && !closing;
    }
    if (
      (piece.kind === "symbol" && /^[+*=<>!|&%^-]+$/u.test(piece.text)) ||
      (prior?.kind === "symbol" && /^[+*=<>!|&%^-]+$/u.test(prior.text))
    ) {
      space = profile.whitespace.operatorSpace;
    }
    if (piece.kind === "symbol" && /^(?:'|"|`)$/u.test(piece.text)) {
      if (quote === piece.text) {
        space = false;
        quote = undefined;
      } else if (!quote) {
        quote = piece.text;
      }
    } else if (prior?.kind === "symbol" && quote === prior.text) {
      space = false;
    }
    if (!result || /\s$/u.test(result) || /^\s/u.test(piece.text)) {
      space = false;
    }
    const separator =
      prior?.rawEnd !== undefined && piece.rawStart !== undefined
        ? source.slice(prior.rawEnd, piece.rawStart)
        : space
          ? " "
          : "";
    result += separator + piece.text;
    prior = piece;
  }
  return result;
}

export function parseDeveloperCommand(
  tokens: readonly DeveloperToken[],
  start: number,
  limit: number,
  request: DeveloperPlanRequest,
  symbols: DeveloperSymbolIndex,
  inCode = false,
): ParsedCommand | undefined {
  const { profile, rawTranscript: source } = request;
  const grammar = profile.grammar;
  const commands = [
    ["literalStart", "literalEnd"],
    ["spellStart", "spellEnd"],
    ["symbolStart", "symbolEnd"],
    ["snakeCase", "identifierEnd"],
    ["camelCase", "identifierEnd"],
    ["pascalCase", "identifierEnd"],
    ["kebabCase", "identifierEnd"],
    ...(!inCode ? [["codeStart", "codeEnd"] as const] : []),
  ] as const;
  for (const [open, close] of commands) {
    const size = matchesPhrase(tokens, start, grammar[open]);
    if (!size) {
      continue;
    }
    let end = findPhrase(tokens, start + size, limit, grammar[close]);
    // A literal escape owns its terminator even when its payload names the
    // surrounding code terminator. Escaped command words remain inert bytes.
    if (open === "codeStart") {
      end = -1;
      for (let cursor = start + size; cursor < limit; cursor++) {
        if (matchesPhrase(tokens, cursor, grammar.literalStart)) {
          const literalEnd = findPhrase(
            tokens,
            cursor + grammar.literalStart.split(" ").length,
            limit,
            grammar.literalEnd,
          );
          if (literalEnd < 0) {
            end = -1;
            break;
          }
          cursor = literalEnd + grammar.literalEnd.split(" ").length - 1;
        } else if (matchesPhrase(tokens, cursor, grammar.codeEnd)) {
          end = cursor;
          break;
        }
      }
    }
    const next = end < 0 ? limit : end + grammar[close].split(" ").length;
    const raw = source.slice(tokens[start]!.start, tokens[next - 1]!.end);
    if (end < 0) {
      return {
        next,
        text: raw,
        diagnostics: [
          diagnostic(
            tokens,
            start,
            next,
            "incomplete",
            `Finish the command with “${grammar[close]}”.`,
          ),
        ],
      };
    }
    const body = tokens.slice(start + size, end);
    let output: string | undefined;
    let diagnostics: DeveloperDiagnostic[] = [];
    if (open === "literalStart") {
      output = body.length ? source.slice(body[0]!.start, body.at(-1)!.end) : "";
    } else if (open === "spellStart") {
      output = spelling(body, profile);
    } else if (open === "symbolStart") {
      const match = matchSymbol(body, 0, body.length, symbols);
      if (match?.next === body.length && body[0]) {
        const resolved = resolveSymbol(match.symbol, body[0], request);
        output = resolved.text;
        diagnostics = resolved.diagnostic ? [resolved.diagnostic] : [];
      }
    } else if (open === "codeStart") {
      const code = parseDeveloperCode(tokens, start + size, end, request, symbols);
      output = code.text;
      diagnostics = code.diagnostics;
    } else if (request.mode === "developer") {
      output = identifier(body, open, profile);
    } else {
      diagnostics = [
        diagnostic(
          tokens,
          start,
          next,
          "unsupported",
          "Identifier casing requires explicitly selecting Developer mode.",
        ),
      ];
    }
    if (output === undefined && diagnostics.length === 0) {
      diagnostics.push(
        diagnostic(
          tokens,
          start,
          next,
          "incomplete",
          "The command has an invalid or unfinished spelling, symbol, or identifier.",
        ),
      );
    }
    return {
      next,
      text: diagnostics.some((item) => item.severity === "blocking") ? raw : (output ?? raw),
      diagnostics,
    };
  }
  return undefined;
}

function parseDeveloperCode(
  tokens: readonly DeveloperToken[],
  start: number,
  end: number,
  request: DeveloperPlanRequest,
  symbols: DeveloperSymbolIndex,
): { text: string; diagnostics: DeveloperDiagnostic[] } {
  const pieces: Piece[] = [];
  const diagnostics: DeveloperDiagnostic[] = [];
  for (let index = start; index < end;) {
    if (diagnostics.length >= 63) {
      diagnostics.push(
        diagnostic(
          tokens,
          index,
          end,
          "limit",
          "The candidate contains too many unresolved commands.",
        ),
      );
      break;
    }
    const token = tokens[index]!;
    const command = parseDeveloperCommand(tokens, index, end, request, symbols, true);
    if (command) {
      pieces.push({ text: command.text, kind: "exact" });
      diagnostics.push(...command.diagnostics);
      index = command.next;
      continue;
    }
    if (matchesPhrase(tokens, index, request.profile.grammar.codeStart)) {
      diagnostics.push(
        diagnostic(tokens, index, end, "incomplete", "Nested code scopes are not supported."),
      );
      break;
    }
    const match = matchSymbol(tokens, index, end, symbols);
    if (match) {
      const resolved = resolveSymbol(match.symbol, token, request);
      if (resolved.diagnostic) {
        diagnostics.push(resolved.diagnostic);
      }
      const value = resolved.text ?? token.text;
      pieces.push({ text: value, kind: /^\s+$/u.test(value) ? "space" : "symbol" });
      index = match.next;
    } else {
      pieces.push({
        text: token.text,
        kind: token.quoted ? "exact" : "word",
        rawStart: token.start,
        rawEnd: token.end,
      });
      index++;
    }
  }
  return { text: renderPieces(pieces, request.profile, request.rawTranscript), diagnostics };
}
