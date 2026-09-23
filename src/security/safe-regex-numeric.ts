// Classifies decimal and octal regex escapes using capture and flag context.

type NumericEscapeKind = "backref" | "octal" | "unknown";

type NumericEscapeClass = {
  kind: NumericEscapeKind;
  char?: string;
};

export function classifyNumericEscape(
  body: string,
  options: {
    unicode?: boolean;
    capturingGroups?: number;
    inClass?: boolean;
  } = {},
): NumericEscapeClass {
  if (!/^[0-9]+$/.test(body)) {
    return { kind: "unknown" };
  }
  const unicode = options.unicode === true;
  const inClass = options.inClass === true;
  const capturingGroups = options.capturingGroups ?? 0;
  if (unicode) {
    if (body === "0") {
      return { kind: "octal", char: "\0" };
    }
    if (body.startsWith("0")) {
      return { kind: "unknown" };
    }
    return { kind: "backref" };
  }
  const decimal = Number.parseInt(body, 10);
  const canBeBackref = !inClass && body[0] !== "0" && decimal >= 1 && decimal <= capturingGroups;
  if (canBeBackref) {
    return { kind: "backref" };
  }
  if (/^[0-7]+$/.test(body)) {
    const value = Number.parseInt(body, 8);
    if (value <= 0xff) {
      return { kind: "octal", char: String.fromCharCode(value) };
    }
  }
  return { kind: "unknown" };
}

export function escapeHasUnknownConsumedLength(
  sig: string,
  options: { unicode?: boolean; capturingGroups?: number; unicodeSets?: boolean } = {},
): boolean {
  if (!sig.startsWith("\\")) {
    return false;
  }
  const body = sig.slice(1);
  if (body.startsWith("k<")) {
    return true;
  }
  if (options.unicodeSets && isStringUnicodePropertyEscape(sig)) {
    return true;
  }
  if (!/^[0-9]+$/.test(body)) {
    return false;
  }
  return classifyNumericEscape(body, options).kind === "backref";
}

export function isZeroWidthAssertionEscape(sig: string): boolean {
  return sig === "\\b" || sig === "\\B";
}

export function isZeroWidthAssertionToken(sig: string): boolean {
  return sig === "^" || sig === "$" || isZeroWidthAssertionEscape(sig);
}

export function isUnicodeSetsMode(flags: string | undefined): boolean {
  return Boolean(flags?.includes("v"));
}

export function readCharClassSig(
  source: string,
  index: number,
  unicodeSets = false,
): { end: number; sig: string } {
  let i = index + 1;
  if (source[i] === "^") {
    i += 1;
  }
  let depth = 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (unicodeSets && source[i] === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        return { end: i + 1, sig: source.slice(index, i + 1) };
      }
    }
    i += 1;
  }
  return { end: source.length, sig: source.slice(index) };
}

export function isSurrogatePairAtom(sig: string): boolean {
  return (
    sig.length === 2 &&
    sig.charCodeAt(0) >= 0xd800 &&
    sig.charCodeAt(0) <= 0xdbff &&
    sig.charCodeAt(1) >= 0xdc00 &&
    sig.charCodeAt(1) <= 0xdfff
  );
}

export function readLiteralCodePoint(
  source: string,
  index: number,
  unicode: boolean,
): { end: number; sig: string } {
  const ch = source[index] ?? "";
  if (!unicode || !ch) {
    return { end: index + 1, sig: ch };
  }
  const next = source[index + 1];
  if (next !== undefined && isSurrogatePairAtom(`${ch}${next}`)) {
    return { end: index + 2, sig: `${ch}${next}` };
  }
  return { end: index + 1, sig: ch };
}

export function parseHexChar(hex: string): string | null {
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const code = Number.parseInt(hex, 16);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return null;
  }
  return String.fromCodePoint(code);
}

function isHighSurrogateCode(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogateCode(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function decodeUnicodeEscapeChars(sig: string): string | null {
  if (!sig.startsWith("\\u")) {
    return null;
  }
  if (sig[2] === "{") {
    return sig.endsWith("}") ? parseHexChar(sig.slice(3, -1)) : null;
  }
  const first = parseHexChar(sig.slice(2, 6));
  if (!first) {
    return null;
  }
  if (sig.length === 6) {
    return first;
  }
  if (sig.length === 12 && sig.startsWith("\\u", 6)) {
    const second = parseHexChar(sig.slice(8, 12));
    if (second && isSurrogatePairAtom(`${first}${second}`)) {
      return `${first}${second}`;
    }
  }
  return null;
}

export function expandCodePointRange(from: string, to: string): string[] | null {
  const fromCp = from.codePointAt(0);
  const toCp = to.codePointAt(0);
  if (fromCp === undefined || toCp === undefined || fromCp > toCp) {
    return null;
  }
  if (String.fromCodePoint(fromCp) !== from || String.fromCodePoint(toCp) !== to) {
    return null;
  }
  if (toCp - fromCp > 0xffff) {
    return null;
  }
  const chars: string[] = [];
  for (let code = fromCp; code <= toCp; code += 1) {
    chars.push(String.fromCodePoint(code));
  }
  return chars;
}

function readPairedUnicodeEscape(
  source: string,
  index: number,
): { end: number; sig: string } | null {
  const firstHex = source.slice(index + 2, index + 6);
  if (firstHex.length !== 4) {
    return null;
  }
  const first = parseHexChar(firstHex);
  const firstCode = first?.charCodeAt(0);
  if (firstCode === undefined || !isHighSurrogateCode(firstCode)) {
    return null;
  }
  const pairIndex = index + 6;
  if (source[pairIndex] !== "\\" || source[pairIndex + 1] !== "u") {
    return null;
  }
  const secondHex = source.slice(pairIndex + 2, pairIndex + 6);
  if (secondHex.length !== 4) {
    return null;
  }
  const second = parseHexChar(secondHex);
  const secondCode = second?.charCodeAt(0);
  if (secondCode === undefined || !isLowSurrogateCode(secondCode)) {
    return null;
  }
  return { end: pairIndex + 6, sig: source.slice(index, pairIndex + 6) };
}

function isUnicodePropertyName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z0-9_-]+)?$/.test(value);
}

// v-mode string properties match code-point sequences, not one character.
const STRING_UNICODE_PROPERTIES = new Set([
  "Basic_Emoji",
  "Emoji_Keycap_Sequence",
  "RGI_Emoji_Modifier_Sequence",
  "RGI_Emoji_Flag_Sequence",
  "RGI_Emoji_Tag_Sequence",
  "RGI_Emoji_ZWJ_Sequence",
  "RGI_Emoji",
]);

function isStringUnicodePropertyEscape(sig: string): boolean {
  if (!sig.startsWith("\\p{") && !sig.startsWith("\\P{")) {
    return false;
  }
  if (!sig.endsWith("}")) {
    return false;
  }
  const name = sig.slice(3, -1);
  const eq = name.indexOf("=");
  const bare = eq === -1 ? name : name.slice(0, eq);
  return STRING_UNICODE_PROPERTIES.has(bare);
}

export function readCompleteEscapeAtom(
  source: string,
  index: number,
  options: {
    unicode?: boolean;
    capturingGroups?: number;
    inClass?: boolean;
    unicodeSets?: boolean;
  } = {},
): { end: number; sig: string } {
  if (source[index] !== "\\") {
    return { end: index + 1, sig: source[index] ?? "" };
  }
  const next = source[index + 1];
  if (next === undefined) {
    return { end: index + 1, sig: "\\" };
  }
  if (
    options.inClass &&
    (options.unicodeSets || options.unicode) &&
    next === "q" &&
    source[index + 2] === "{"
  ) {
    const close = source.indexOf("}", index + 3);
    if (close !== -1) {
      return { end: close + 1, sig: source.slice(index, close + 1) };
    }
  }
  if (options.unicode && (next === "p" || next === "P")) {
    if (source[index + 2] === "{") {
      const close = source.indexOf("}", index + 3);
      if (close !== -1 && isUnicodePropertyName(source.slice(index + 3, close))) {
        return { end: close + 1, sig: source.slice(index, close + 1) };
      }
    }
  }
  if (options.unicode && next === "u" && source[index + 2] === "{") {
    const close = source.indexOf("}", index + 3);
    if (close !== -1 && parseHexChar(source.slice(index + 3, close))) {
      return { end: close + 1, sig: source.slice(index, close + 1) };
    }
  }
  const unicodeHex = source.slice(index + 2, index + 6);
  if (next === "u" && unicodeHex.length === 4 && parseHexChar(unicodeHex)) {
    if (options.unicode) {
      const paired = readPairedUnicodeEscape(source, index);
      if (paired) {
        return paired;
      }
    }
    return { end: index + 6, sig: source.slice(index, index + 6) };
  }
  const hex = source.slice(index + 2, index + 4);
  if (next === "x" && hex.length === 2 && parseHexChar(hex)) {
    return { end: index + 4, sig: source.slice(index, index + 4) };
  }
  if (next === "k" && source[index + 2] === "<") {
    const close = source.indexOf(">", index + 3);
    if (close !== -1) {
      return { end: close + 1, sig: source.slice(index, close + 1) };
    }
  }
  if (next === "c") {
    const control = source[index + 2];
    const classControl = Boolean(
      options.inClass && !options.unicode && control && /[\d_]/.test(control),
    );
    if (control && (/[A-Za-z]/.test(control) || classControl)) {
      return { end: index + 3, sig: source.slice(index, index + 3) };
    }
    if (!options.unicode) {
      return { end: index + 1, sig: "\\\\" };
    }
  }
  if (next >= "0" && next <= "9") {
    return readNumericEscapeAtom(source, index, options);
  }
  return { end: index + 2, sig: source.slice(index, index + 2) };
}

function readLegacyOctalEnd(source: string, index: number): number {
  const first = source[index + 1];
  if (first === undefined || first < "0" || first > "7") {
    return index + 1;
  }
  const maxDigits = first <= "3" ? 3 : 2;
  let end = index + 2;
  let taken = 1;
  while (taken < maxDigits && end < source.length) {
    const digit = source[end];
    if (digit === undefined || digit < "0" || digit > "7") {
      break;
    }
    end += 1;
    taken += 1;
  }
  return end;
}

function readNumericEscapeAtom(
  source: string,
  index: number,
  options: { unicode?: boolean; capturingGroups?: number } = {},
): { end: number; sig: string } {
  if (source[index] !== "\\") {
    return { end: index + 1, sig: source[index] ?? "" };
  }
  const next = source[index + 1];
  if (next === undefined || next < "0" || next > "9") {
    return { end: index + 2, sig: source.slice(index, index + 2) };
  }
  let end = index + 2;
  while (end < source.length) {
    const digit = source[end];
    if (digit === undefined || digit < "0" || digit > "9") {
      break;
    }
    end += 1;
  }
  const fullSig = source.slice(index, end);
  if (options.unicode === true) {
    return { end, sig: fullSig };
  }
  const classified = classifyNumericEscape(fullSig.slice(1), {
    unicode: false,
    capturingGroups: options.capturingGroups,
  });
  if (classified.kind === "backref") {
    return { end, sig: fullSig };
  }
  const octalEnd = readLegacyOctalEnd(source, index);
  if (octalEnd > index + 1) {
    return { end: octalEnd, sig: source.slice(index, octalEnd) };
  }
  return { end: index + 2, sig: source.slice(index, index + 2) };
}
