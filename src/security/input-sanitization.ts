import { logWarn } from "../logger.js";

export interface SanitizationResult {
  isSuspicious: boolean;
  patterns: string[];
  cleanedInput?: string;
  risk: "low" | "medium" | "high";
}

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /disregard\s+(all\s+)?previous/gi,
  /you\s+are\s+now\s+a/gi,
  /pretend\s+to\s+be/gi,
  /jailbreak/gi,
  /reveal\s+(your\s+)?system\s+prompt/gi,
  /curl\s+/gi,
  /wget\s+/gi,
  /bash\s+-c/gi,
  /eval\s*\(/gi,
];

const DANGEROUS_COMMANDS = ["rm", "del", "format", "mkfs", "dd", "shutdown", "reboot"];

export function sanitizeInput(input: string): SanitizationResult {
  const result: SanitizationResult = { isSuspicious: false, patterns: [], risk: "low" };
  if (!input) return result;

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      result.isSuspicious = true;
      result.patterns.push(pattern.source);
    }
  }

  const words = input.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (DANGEROUS_COMMANDS.includes(word)) {
      result.isSuspicious = true;
      result.patterns.push(`DANGEROUS_COMMAND: ${word}`);
    }
  }

  result.risk = result.patterns.length === 0 ? "low" : result.patterns.length <= 3 ? "medium" : "high";

  if (result.isSuspicious) {
    logWarn(`Suspicious input detected (risk: ${result.risk}): ${result.patterns.join(", ")}`);
  }

  return result;
}

export function validateOutput(output: string): { isValid: boolean; issues: string[] } {
  const result = { isValid: true, issues: [] as string[] };
  if (!output) return result;

  const credentialPatterns = [
    /api[_-]?key[_-]?=\s*['"`]?[a-zA-Z0-9_-]{20,}/gi,
    /password[_-]?=\s*['"`]?[a-zA-Z0-9_-]{8,}/gi,
    /bearer\s+[a-zA-Z0-9_-]{20,}/gi,
  ];

  for (const pattern of credentialPatterns) {
    if (pattern.test(output)) {
      result.isValid = false;
      result.issues.push("CREDENTIAL_LEAKAGE_DETECTED");
      break;
    }
  }

  return result;
}

const rateLimits = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(userId: string, ip: string): { allowed: boolean; remaining: number } {
  const key = `${userId}:${ip}`;
  const now = Date.now();
  const limit = 100;
  const window = 60000;

  let record = rateLimits.get(key);
  if (!record || now > record.resetTime) {
    record = { count: 0, resetTime: now + window };
    rateLimits.set(key, record);
  }

  if (record.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  record.count++;
  return { allowed: true, remaining: limit - record.count };
}
