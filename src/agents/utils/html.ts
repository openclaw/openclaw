/**
 * Minimal HTML entity decoding helpers.
 *
 * Syntax highlighting and terminal renderers use this to decode the small
 * entity subset emitted by trusted HTML producers without parsing full HTML.
 */
/** Decoded entity text plus the source length consumed from the input. */
interface DecodedHtmlEntity {
  text: string;
  length: number;
}

function decodeCodePoint(codePoint: number): string | undefined {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return undefined;
  }
  return String.fromCodePoint(codePoint);
}

/** Decodes a named or numeric HTML entity without the surrounding `&`/`;`. */
function decodeHtmlEntity(entity: string): string | undefined {
  // Named entities match case-insensitively so callers keep the long-standing
  // contract of decoding forms like "&AMP;" instead of leaking them as text.
  switch (entity.toLowerCase()) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
  }

  // Numeric references must be fully numeric. A bare Number.parseInt is lenient
  // and would consume a malformed entity such as "&#39x;" as "'" by stopping at
  // the first non-digit; require the whole token to be valid digits instead.
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const hex = entity.slice(2);
    return /^[0-9a-fA-F]+$/.test(hex) ? decodeCodePoint(Number.parseInt(hex, 16)) : undefined;
  }

  if (entity.startsWith("#")) {
    const dec = entity.slice(1);
    return /^[0-9]+$/.test(dec) ? decodeCodePoint(Number.parseInt(dec, 10)) : undefined;
  }

  return undefined;
}

/** Decodes an entity starting at `index` in an HTML string. */
export function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined {
  const semicolonIndex = html.indexOf(";", index + 1);
  if (semicolonIndex === -1 || semicolonIndex - index > 16) {
    return undefined;
  }

  const entity = html.slice(index + 1, semicolonIndex);
  const decoded = decodeHtmlEntity(entity);
  if (decoded === undefined) {
    return undefined;
  }

  return { text: decoded, length: semicolonIndex - index + 1 };
}
