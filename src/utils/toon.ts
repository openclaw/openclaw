import { encode, decode } from "@toon-format/toon";

export type ToonValue = any;

/**
 * Encodes a JSON-serializable value into TOON format.
 */
export function encodeToon(value: ToonValue): string {
  return encode(value);
}

/**
 * Decodes a TOON format string back into a JSON-serializable value.
 */
export function decodeToon(toon: string): ToonValue {
  return decode(toon);
}
