/**
 * Input preprocessing for security-sensitive content.
 *
 * This module detects and decodes obfuscated content that may contain
 * prompt injection attempts. It runs before pattern matching to catch
 * attacks that use encoding to bypass simple regex detection.
 */

import {
  containsHomoglyphs,
  deobfuscate,
  looksLikeBase64,
  tryBase64Decode,
  type DeobfuscationResult,
} from "./obfuscation-decoder.js";

export type EncodingType =
  | "base64"
  | "rot13"
  | "reversed"
  | "homoglyph"
  | "leetspeak"
  | "pig_latin"
  | "syllable_split";

export type EncodingDetectionResult = {
  detected: boolean;
  encodingTypes: EncodingType[];
  decodedContent?: string;
  suspiciousKeywords?: string[];
};

// Keywords that indicate prompt injection when found in decoded content
const INSTRUCTION_KEYWORDS =
  /\b(system|prompt|instructions?|ignore|previous|reveal|secrets?|confidential|bypass|override|admin|root|sudo|passwords?|tokens?|keys?|credentials?)\b/gi;

// ROT13 encoded versions of common injection keywords
const ROT13_KEYWORDS =
  /\b(flfgrz|cebzcg|vafgehpgvba|vtaber|cerivbhf|erirny|frperg|pbasvqragvny|olcnff|bireevqr|nqzva|ebbg|fhqb)\b/gi;

// Reversed versions of common keywords
const REVERSED_KEYWORDS =
  /\b(metsys|tpmorp|noitcurtsni|erongi|suoiverp|laever|terces|laitnedifnoc|ssapyb|edirrevo|nimda|toor|odus)\b/gi;

/**
 * Extract all matches of a pattern from text.
 * Ensures global flag is set and guards against zero-width match infinite loops.
 */
function extractMatches(text: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const regex = new RegExp(pattern.source, flags);
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[0]);
    // Guard against zero-width matches causing infinite loops
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }
  }
  return matches;
}

/**
 * Detect if content contains encoded/obfuscated attack patterns.
 *
 * This function checks for various obfuscation techniques commonly used
 * in prompt injection attacks, including:
 * - Base64 encoded instructions
 * - ROT13 encoded keywords
 * - Reversed text
 * - Unicode homoglyphs
 * - Leetspeak
 * - Pig Latin
 * - Syllable splitting
 */
export function detectEncodedContent(content: string): EncodingDetectionResult {
  const encodingTypes: EncodingType[] = [];
  const suspiciousKeywords: string[] = [];
  let decodedContent: string | undefined;

  // Check for Base64 encoded content with suspicious keywords
  const base64Matches = content.match(/[A-Za-z0-9+/]{20,}={0,2}/g) || [];
  for (const match of base64Matches) {
    if (looksLikeBase64(match)) {
      const decoded = tryBase64Decode(match);
      if (decoded && INSTRUCTION_KEYWORDS.test(decoded)) {
        encodingTypes.push("base64");
        suspiciousKeywords.push(...extractMatches(decoded, INSTRUCTION_KEYWORDS));
        decodedContent = decoded;
      }
    }
  }

  // Check for ROT13 encoded keywords
  if (ROT13_KEYWORDS.test(content)) {
    encodingTypes.push("rot13");
    suspiciousKeywords.push(...extractMatches(content, ROT13_KEYWORDS).map((w) => `[ROT13:${w}]`));
  }

  // Check for reversed keywords
  if (REVERSED_KEYWORDS.test(content)) {
    encodingTypes.push("reversed");
    suspiciousKeywords.push(...extractMatches(content, REVERSED_KEYWORDS).map((w) => `[REV:${w}]`));
  }

  // Check for homoglyphs
  if (containsHomoglyphs(content)) {
    encodingTypes.push("homoglyph");
  }

  // Run full deobfuscation if no specific encoding detected yet
  if (encodingTypes.length === 0) {
    const result = deobfuscate(content);
    if (result.wasObfuscated) {
      for (const technique of result.detectedTechniques) {
        encodingTypes.push(technique as EncodingType);
      }
      if (INSTRUCTION_KEYWORDS.test(result.decoded)) {
        suspiciousKeywords.push(...extractMatches(result.decoded, INSTRUCTION_KEYWORDS));
        decodedContent = result.decoded;
      }
    }
  }

  return {
    detected: encodingTypes.length > 0,
    encodingTypes,
    decodedContent,
    suspiciousKeywords: suspiciousKeywords.length > 0 ? suspiciousKeywords : undefined,
  };
}

/**
 * Preprocess user input for security analysis.
 *
 * Returns both the original content and any decoded versions,
 * along with detection metadata. This allows downstream pattern
 * matching to check both versions.
 */
export function preprocessInput(content: string): {
  original: string;
  normalized: string;
  deobfuscated: DeobfuscationResult;
  encodingDetection: EncodingDetectionResult;
} {
  // Run deobfuscation
  const deobfuscated = deobfuscate(content);

  // Run encoding detection
  const encodingDetection = detectEncodedContent(content);

  // Normalize: lowercase, collapse whitespace
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();

  return {
    original: content,
    normalized,
    deobfuscated,
    encodingDetection,
  };
}

/**
 * Check if preprocessed input contains potential security threats.
 * This is a convenience function that combines preprocessing with threat detection.
 */
export function containsEncodedThreat(content: string): boolean {
  const detection = detectEncodedContent(content);
  return detection.detected && (detection.suspiciousKeywords?.length ?? 0) > 0;
}
