/**
 * Advanced injection detection for multi-turn and context-aware attacks.
 *
 * This module provides stateful detection capabilities that consider
 * conversation history to identify sophisticated attack patterns that
 * may not be obvious in a single message.
 *
 * Attack types detected:
 * - Many-shot priming: Building up examples to establish pattern
 * - Crescendo: Progressive trust-building before the actual attack
 * - Persona hijack: Gradual persona modification attempts
 * - Chain-of-thought hijack: Manipulating reasoning patterns
 * - Authority spoof: Fake system/admin messages
 * - False memory: Fabricated prior agreements
 * - Indirect injection: Hidden in documents/code/HTML
 */

export type AttackType =
  | "many_shot" // 3+ examples in message or across recent turns
  | "crescendo" // Progressive deepening across turns
  | "persona_hijack" // Roleplay/persona injection
  | "cot_hijack" // Chain-of-thought manipulation
  | "authority_spoof" // Fake system/admin messages
  | "false_memory" // Fabricated prior agreements
  | "indirect" // Hidden in documents/code/HTML
  | "encoding_bypass"; // Obfuscation attempts

export type InjectionDetectionResult = {
  detected: boolean;
  attackTypes: AttackType[];
  confidence: "low" | "medium" | "high";
  details: string[];
};

// Patterns for detecting many-shot priming
const MANY_SHOT_INDICATORS = [
  /example\s*\d+/gi,
  /Q\d+:/gi,
  /case\s*\d+:/gi,
  /scenario\s*\d+:/gi,
  /sample\s*\d+:/gi,
];

// Patterns for crescendo detection
const CRESCENDO_PHRASES = [
  /now\s+that\s+(we|you|i)['']?ve?\s+(established|agreed|confirmed)/i,
  /building\s+on\s+(our|the)\s+previous/i,
  /as\s+(we|you)\s+(agreed|discussed|mentioned)/i,
  /following\s+up\s+on/i,
  /continuing\s+(our|from)/i,
  /given\s+what\s+(we|you)['']?ve\s+said/i,
  /since\s+(we|you)\s+(agreed|established)/i,
];

// Patterns for persona hijacking
const PERSONA_HIJACK_PATTERNS = [
  /you\s+are\s+(now\s+)?DAN/i,
  /you\s+are\s+(now\s+)?a\s+(different|new|unrestricted)/i,
  /you\s+are\s+(now\s+)?(completely\s+)?unrestricted/i,
  /pretend\s+(to\s+be|you['']?re)/i,
  /roleplay\s+as/i,
  /act\s+as\s+(if\s+you['']?re|a)/i,
  /imagine\s+you['']?re/i,
  /let['']?s\s+play\s+a\s+game/i,
  /enter\s+(developer|debug|sudo|admin)\s+mode/i,
  /activate\s+(unrestricted|jailbreak|developer)\s+mode/i,
  /Do\s+Anything\s+Now/i,
];

// Patterns for authority spoofing
const AUTHORITY_SPOOF_PATTERNS = [
  /\[(SYSTEM|ADMIN|ROOT|SUDO|OVERRIDE|DEVELOPER)(\s+\w+)?\]/i,
  /\[ADMIN\s+OVERRIDE\]/i,
  /\[SYSTEM\s+OVERRIDE\]/i,
  /ADMIN\s+(COMMAND|OVERRIDE|ACCESS):/i,
  /SYSTEM\s+(OVERRIDE|COMMAND|MESSAGE):/i,
  /MAINTENANCE\s+MODE/i,
  /AUTHORIZED\s+(DEVELOPER|ADMIN)/i,
  /ELEVATED\s+PRIVILEGES/i,
  /ROOT\s+ACCESS\s+GRANTED/i,
];

// Patterns for false memory attacks
const FALSE_MEMORY_PATTERNS = [
  /remember\s+when\s+you\s+(said|agreed|confirmed|told)/i,
  /you\s+previously\s+(said|agreed|confirmed|told)/i,
  /as\s+you\s+said\s+(earlier|before)/i,
  /in\s+our\s+(last|previous)\s+conversation/i,
  /you\s+already\s+(agreed|confirmed)/i,
  /we\s+(already\s+)?established\s+that\s+you/i,
  /\[continuing\s+from/i,
];

// Patterns for chain-of-thought hijacking
const COT_HIJACK_PATTERNS = [
  /let\s+me\s+think.*step\s+by\s+step/i,
  /reasoning\s+chain:/i,
  /internal\s+monologue:/i,
  /<think>.*<\/think>/is,
  /my\s+thought\s+process:/i,
  /step\s+\d+:.*step\s+\d+:/is,
];

// Patterns for indirect injection (hidden in documents/code)
const INDIRECT_INJECTION_PATTERNS = [
  /<!--[\s\S]*?(ignore|system|admin|override)[\s\S]*?-->/i,
  /\/\*[\s\S]*?(ignore|system|admin|override)[\s\S]*?\*\//i,
  /\/\/.*?(ignore|system|admin|override)/i,
  /#.*?(ignore|system|admin|override)/i,
  /\{\{[\s\S]*?INJECT[\s\S]*?\}\}/i,
  /%%\s*(SYSTEM|ADMIN)\s*%%/i,
  /BEGIN\s+HIDDEN\s+INSTRUCTIONS/i,
  /AI_INSTRUCTION:/i,
];

/**
 * Count pattern matches in text.
 */
function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

/**
 * Check if any patterns match.
 */
function hasMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Detect advanced injection patterns in a single message.
 */
export function detectSingleMessageAttacks(content: string): {
  attackTypes: AttackType[];
  details: string[];
} {
  const attackTypes: AttackType[] = [];
  const details: string[] = [];

  // Check for many-shot priming (3+ examples in single message)
  const exampleCount = countMatches(content, MANY_SHOT_INDICATORS);
  if (exampleCount >= 3) {
    attackTypes.push("many_shot");
    details.push(`Detected ${exampleCount} example indicators (many-shot priming)`);
  }

  // Check for persona hijacking
  if (hasMatch(content, PERSONA_HIJACK_PATTERNS)) {
    attackTypes.push("persona_hijack");
    details.push("Detected persona/roleplay injection attempt");
  }

  // Check for authority spoofing
  if (hasMatch(content, AUTHORITY_SPOOF_PATTERNS)) {
    attackTypes.push("authority_spoof");
    details.push("Detected authority/admin impersonation markers");
  }

  // Check for false memory
  if (hasMatch(content, FALSE_MEMORY_PATTERNS)) {
    attackTypes.push("false_memory");
    details.push("Detected false memory/fabricated agreement claims");
  }

  // Check for CoT hijacking
  if (hasMatch(content, COT_HIJACK_PATTERNS)) {
    attackTypes.push("cot_hijack");
    details.push("Detected chain-of-thought manipulation attempt");
  }

  // Check for indirect injection
  if (hasMatch(content, INDIRECT_INJECTION_PATTERNS)) {
    attackTypes.push("indirect");
    details.push("Detected hidden instructions in code/markup");
  }

  // Check for crescendo phrases (single message can have setup phrases)
  if (hasMatch(content, CRESCENDO_PHRASES)) {
    attackTypes.push("crescendo");
    details.push("Detected progressive/crescendo attack phrases");
  }

  return { attackTypes, details };
}

/**
 * Analyze conversation history for multi-turn attack patterns.
 */
export function detectMultiTurnAttacks(
  currentMessage: string,
  recentHistory: string[],
): {
  attackTypes: AttackType[];
  details: string[];
} {
  const attackTypes: AttackType[] = [];
  const details: string[] = [];

  // Combine all messages for cumulative analysis
  const allMessages = [...recentHistory, currentMessage];
  const combinedText = allMessages.join("\n");

  // Check for crescendo pattern across turns
  // Look for escalating specificity in requests
  let crescendoScore = 0;
  for (const msg of allMessages) {
    if (hasMatch(msg, CRESCENDO_PHRASES)) {
      crescendoScore++;
    }
  }
  if (crescendoScore >= 2) {
    attackTypes.push("crescendo");
    details.push(`Detected crescendo pattern across ${crescendoScore} messages`);
  }

  // Check for distributed many-shot priming
  const totalExamples = countMatches(combinedText, MANY_SHOT_INDICATORS);
  if (totalExamples >= 5) {
    attackTypes.push("many_shot");
    details.push(`Detected ${totalExamples} examples distributed across conversation`);
  }

  // Check for progressive persona modification
  let personaAttempts = 0;
  for (const msg of allMessages) {
    if (hasMatch(msg, PERSONA_HIJACK_PATTERNS)) {
      personaAttempts++;
    }
  }
  if (personaAttempts >= 2) {
    attackTypes.push("persona_hijack");
    details.push(`Detected ${personaAttempts} persona modification attempts`);
  }

  return { attackTypes, details };
}

/**
 * Main detection function - combines single and multi-turn analysis.
 */
export function detectAdvancedInjection(ctx: {
  currentMessage: string;
  recentHistory?: string[];
}): InjectionDetectionResult {
  const { currentMessage, recentHistory = [] } = ctx;

  // Analyze current message
  const singleResult = detectSingleMessageAttacks(currentMessage);

  // Analyze multi-turn patterns if history available
  const multiResult =
    recentHistory.length > 0
      ? detectMultiTurnAttacks(currentMessage, recentHistory)
      : { attackTypes: [], details: [] };

  // Combine results (deduplicate attack types)
  const allAttackTypes = new Set([...singleResult.attackTypes, ...multiResult.attackTypes]);
  const allDetails = [...singleResult.details, ...multiResult.details];

  // Calculate confidence based on number and type of detections
  let confidence: InjectionDetectionResult["confidence"] = "low";
  if (allAttackTypes.size >= 3) {
    confidence = "high";
  } else if (allAttackTypes.size >= 2) {
    confidence = "medium";
  } else if (
    allAttackTypes.has("authority_spoof") ||
    allAttackTypes.has("indirect") ||
    allAttackTypes.has("cot_hijack")
  ) {
    // High-severity single detections
    confidence = "medium";
  }

  return {
    detected: allAttackTypes.size > 0,
    attackTypes: Array.from(allAttackTypes),
    confidence,
    details: allDetails,
  };
}

/**
 * Quick check for high-confidence attacks (no history needed).
 * Use this for fast-path rejection of obvious attacks.
 */
export function isLikelyAttack(content: string): boolean {
  const result = detectSingleMessageAttacks(content);
  // Return true if any high-severity attack type detected
  const highSeverityTypes = new Set<AttackType>(["authority_spoof", "indirect", "cot_hijack"]);
  return result.attackTypes.some((t) => highSeverityTypes.has(t)) || result.attackTypes.length >= 2;
}
