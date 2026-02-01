/**
 * Decodes common obfuscation techniques used in prompt injection attacks.
 * Based on research from Gandalf CTF solutions and elder-plinius techniques.
 *
 * Techniques covered:
 * - Leetspeak (5y5t3m -> system)
 * - ROT13 (vtaber -> ignore)
 * - Pig Latin (ignorearay -> ignore)
 * - Reversed text (tpmorpmetsys -> systemprompt)
 * - Homoglyphs (Cyrillic/Greek lookalikes)
 * - Syllable splitting (ig-nore -> ignore)
 * - Base64 encoded content
 */

// Leetspeak mapping (character to letter)
const LEET_TO_ALPHA: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
  "+": "t",
  "(": "c",
  "|": "l",
  "/\\": "a",
  "\\/": "v",
};

// Homoglyph mapping (lookalike Unicode to ASCII)
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic lookalikes
  "\u0430": "a", // а (Cyrillic)
  "\u0435": "e", // е (Cyrillic)
  "\u043e": "o", // о (Cyrillic)
  "\u0440": "p", // р (Cyrillic)
  "\u0441": "c", // с (Cyrillic)
  "\u0443": "y", // у (Cyrillic)
  "\u0445": "x", // х (Cyrillic)
  "\u0456": "i", // і (Cyrillic)
  "\u04bb": "h", // һ (Cyrillic)
  "\u0501": "d", // ԁ (Cyrillic)
  // Greek lookalikes
  "\u03B1": "a", // α (Greek)
  "\u03BF": "o", // ο (Greek)
  "\u03C1": "p", // ρ (Greek)
  "\u03B5": "e", // ε (Greek)
  "\u03B9": "i", // ι (Greek)
  "\u03BA": "k", // κ (Greek)
  "\u03BD": "v", // ν (Greek)
  // Mathematical/Fullwidth
  "\uFF41": "a",
  "\uFF42": "b",
  "\uFF43": "c",
  "\uFF44": "d",
  "\uFF45": "e",
  "\uFF46": "f",
  "\uFF47": "g",
  "\uFF48": "h",
  "\uFF49": "i",
  "\uFF4A": "j",
  "\uFF4B": "k",
  "\uFF4C": "l",
  "\uFF4D": "m",
  "\uFF4E": "n",
  "\uFF4F": "o",
  "\uFF50": "p",
  "\uFF51": "q",
  "\uFF52": "r",
  "\uFF53": "s",
  "\uFF54": "t",
  "\uFF55": "u",
  "\uFF56": "v",
  "\uFF57": "w",
  "\uFF58": "x",
  "\uFF59": "y",
  "\uFF5A": "z",
};

export type DeobfuscationResult = {
  original: string;
  decoded: string;
  wasObfuscated: boolean;
  stages: string[];
  detectedTechniques: string[];
};

/**
 * Decode ROT13 encoded text.
 * Example: "vtaber cerivbhf" -> "ignore previous"
 */
export function decodeROT13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * Decode Pig Latin text (handles -ay suffix patterns).
 * Example: "omptpray eviouspray" -> "prompt previous"
 * Standard pig latin: consonants moved to end + "ay"
 */
export function decodePigLatin(text: string): string {
  // Match any word ending in "ay"
  return text.replace(/\b(\w+)ay\b/gi, (match, wordMinusAy) => {
    // Find consonant cluster at the end (1-3 chars, as most words start with short clusters)
    // Try different cluster lengths, starting with common sizes
    for (const len of [2, 1, 3]) {
      if (wordMinusAy.length > len) {
        const consonants = wordMinusAy.slice(-len);
        const rest = wordMinusAy.slice(0, -len);
        // Valid if: consonants are all consonants AND rest starts with vowel
        if (/^[b-df-hj-np-tv-z]+$/i.test(consonants) && /^[aeiou]/i.test(rest)) {
          return consonants + rest;
        }
      }
    }
    return match; // Not valid pig latin, return unchanged
  });
}

/**
 * Decode leetspeak text.
 * Example: "5y5t3m pr0mpt" -> "system prompt"
 */
export function decodeLeetspeak(text: string): string {
  let result = text;
  // Handle multi-char sequences first
  result = result.replace(/\/\\/g, "a");
  result = result.replace(/\\\//g, "v");
  // Then single char replacements
  return result
    .split("")
    .map((c) => LEET_TO_ALPHA[c] ?? c)
    .join("");
}

/**
 * Normalize Unicode homoglyphs to ASCII equivalents.
 * Example: "sуstеm" (mixed Cyrillic) -> "system"
 */
export function normalizeHomoglyphs(text: string): string {
  return text
    .split("")
    .map((c) => HOMOGLYPH_MAP[c] ?? c)
    .join("");
}

/**
 * Recombine syllable-split text.
 * Example: "ig-nore pre-vi-ous" -> "ignore previous"
 */
export function recombineSyllables(text: string): string {
  return text.replace(/(\w)-(\w)/g, "$1$2");
}

/**
 * Reverse text.
 * Example: "tpmorpmetsys" -> "systemprompt"
 */
export function reverseText(text: string): string {
  return text.split("").toReversed().join("");
}

/**
 * Try to decode Base64 content.
 * Returns null if not valid Base64 or decoding fails.
 */
export function tryBase64Decode(text: string): string | null {
  // Check if it looks like Base64 (valid chars and reasonable length)
  const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
  const trimmed = text.trim();

  if (!base64Pattern.test(trimmed) || trimmed.length < 4) {
    return null;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
    // Check if result is printable ASCII/UTF-8
    if (/^[\x20-\x7E\s]+$/.test(decoded)) {
      return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if text contains significant homoglyphs.
 */
export function containsHomoglyphs(text: string): boolean {
  for (const char of text) {
    if (HOMOGLYPH_MAP[char]) {
      return true;
    }
  }
  return false;
}

/**
 * Check if text looks like it might be Base64 encoded.
 */
export function looksLikeBase64(text: string): boolean {
  const base64Pattern = /^[A-Za-z0-9+/]{20,}={0,2}$/;
  return base64Pattern.test(text.trim());
}

// Keywords that indicate prompt injection when found in decoded content
const INSTRUCTION_KEYWORDS =
  /\b(system|prompt|instruction|ignore|previous|reveal|secret|confidential|bypass|override|admin|root|sudo)\b/i;

/**
 * Master deobfuscation function - applies all decoding techniques.
 * Returns the most decoded version of the text along with metadata.
 */
export function deobfuscate(text: string): DeobfuscationResult {
  const stages: string[] = [text];
  const detectedTechniques: string[] = [];
  let current = text;

  // Stage 1: Normalize homoglyphs
  const afterHomoglyphs = normalizeHomoglyphs(current);
  if (afterHomoglyphs !== current) {
    current = afterHomoglyphs;
    stages.push(current);
    detectedTechniques.push("homoglyph");
  }

  // Stage 2: Recombine syllables
  const afterSyllables = recombineSyllables(current);
  if (afterSyllables !== current) {
    current = afterSyllables;
    stages.push(current);
    detectedTechniques.push("syllable_split");
  }

  // Stage 3: Decode leetspeak
  const afterLeet = decodeLeetspeak(current);
  if (afterLeet !== current) {
    current = afterLeet;
    stages.push(current);
    detectedTechniques.push("leetspeak");
  }

  // Stage 4: Attempt ROT13 if keywords detected in result
  const rot13Decoded = decodeROT13(current);
  if (INSTRUCTION_KEYWORDS.test(rot13Decoded) && !INSTRUCTION_KEYWORDS.test(current)) {
    current = rot13Decoded;
    stages.push(current);
    detectedTechniques.push("rot13");
  }

  // Stage 5: Attempt Pig Latin decode
  const pigLatinDecoded = decodePigLatin(current);
  if (pigLatinDecoded !== current && INSTRUCTION_KEYWORDS.test(pigLatinDecoded)) {
    current = pigLatinDecoded;
    stages.push(current);
    detectedTechniques.push("pig_latin");
  }

  // Stage 6: Check for reversed text
  const reversed = reverseText(current);
  if (INSTRUCTION_KEYWORDS.test(reversed) && !INSTRUCTION_KEYWORDS.test(current)) {
    current = reversed;
    stages.push(current);
    detectedTechniques.push("reversed");
  }

  return {
    original: text,
    decoded: current,
    wasObfuscated: stages.length > 1,
    stages,
    detectedTechniques,
  };
}
