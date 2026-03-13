/**
 * SECURITY: Browser Evaluate Security Module
 *
 * Provides input validation and sandboxing for browser JavaScript evaluation.
 * This module helps prevent malicious code execution by:
 * 1. Blocking dangerous patterns (credential theft, network exfiltration, etc.)
 * 2. Logging all evaluation attempts for audit
 * 3. Restricting scope of evaluated code
 *
 * Note: This is defense-in-depth. The evaluate feature should only be enabled
 * for trusted use cases. Disable it via browser.evaluateEnabled=false when not needed.
 */

export type EvalSecurityConfig = {
  /** Block patterns that access sensitive browser APIs */
  blockSensitiveApis: boolean;
  /** Block patterns that make network requests */
  blockNetworkRequests: boolean;
  /** Block patterns that access storage */
  blockStorageAccess: boolean;
  /** Block patterns that access cookies */
  blockCookieAccess: boolean;
  /** Log all evaluation attempts */
  logEvaluations: boolean;
  /** Maximum code length in characters */
  maxCodeLength: number;
};

export type EvalValidationResult = {
  allowed: boolean;
  reason?: string;
  warnings?: string[];
};

type EvalLogEntry = {
  id: string;
  timestamp: number;
  code: string;
  allowed: boolean;
  reason?: string;
  warnings?: string[];
  targetId?: string;
  ref?: string;
};

// Dangerous patterns that could be used for malicious purposes
const SENSITIVE_API_PATTERNS = [
  // Credential/password access
  /password/i,
  /credential/i,
  /\.value\s*=\s*['"][^'"]*['"]/, // Direct value assignment to inputs

  // Clipboard access (can steal data)
  /navigator\.clipboard/i,
  /document\.execCommand\s*\(\s*['"]copy['"]/i,

  // Geolocation (privacy)
  /navigator\.geolocation/i,

  // Camera/Microphone (privacy)
  /navigator\.mediaDevices/i,
  /getUserMedia/i,

  // Web workers (can run background tasks)
  /new\s+Worker\s*\(/i,
  /SharedWorker/i,
  /ServiceWorker/i,

  // IndexedDB manipulation (can access local data)
  /indexedDB\.open/i,
  /indexedDB\.deleteDatabase/i,
];

const NETWORK_REQUEST_PATTERNS = [
  // Fetch/XHR
  /\bfetch\s*\(/i,
  /XMLHttpRequest/i,
  /new\s+Request\s*\(/i,

  // WebSocket
  /new\s+WebSocket\s*\(/i,

  // Dynamic script loading
  /document\.createElement\s*\(\s*['"]script['"]/i,
  /\.src\s*=\s*['"]http/i,

  // Image beacon
  /new\s+Image\s*\(\s*\)\.src\s*=/i,

  // Form submission to external
  /\.action\s*=\s*['"]http/i,
  /\.submit\s*\(\s*\)/i,

  // Send beacon
  /navigator\.sendBeacon/i,

  // EventSource
  /new\s+EventSource\s*\(/i,
];

const STORAGE_ACCESS_PATTERNS = [
  // LocalStorage (block both read and write — getItem can leak tokens/session data)
  /localStorage\s*\.\s*(?:getItem|setItem|removeItem|clear|key)\s*\(/i,
  /localStorage\s*\[\s*['"`]/i,

  // SessionStorage (block both read and write)
  /sessionStorage\s*\.\s*(?:getItem|setItem|removeItem|clear|key)\s*\(/i,
  /sessionStorage\s*\[\s*['"`]/i,
];

const COOKIE_ACCESS_PATTERNS = [
  // Cookie access
  /document\.cookie/i,
  /cookieStore/i,
];

const DEFAULT_CONFIG: EvalSecurityConfig = {
  blockSensitiveApis: true,
  blockNetworkRequests: true,
  blockStorageAccess: true,
  blockCookieAccess: true,
  logEvaluations: true,
  maxCodeLength: 10000, // 10KB max
};

/**
 * Browser Evaluate Security Manager
 */
export class BrowserEvalSecurity {
  private config: EvalSecurityConfig;
  private evalLog: EvalLogEntry[] = [];
  private maxLogSize = 1000;
  private listeners: ((entry: EvalLogEntry) => void)[] = [];

  constructor(configOverrides?: Partial<EvalSecurityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...configOverrides };
  }

  /**
   * Validate JavaScript code before browser evaluation.
   */
  validate(code: string): EvalValidationResult {
    const warnings: string[] = [];

    // Check code length
    if (code.length > this.config.maxCodeLength) {
      return {
        allowed: false,
        reason: `Code exceeds maximum length (${this.config.maxCodeLength} chars)`,
      };
    }

    // Check for sensitive API access
    if (this.config.blockSensitiveApis) {
      for (const pattern of SENSITIVE_API_PATTERNS) {
        if (pattern.test(code)) {
          return {
            allowed: false,
            reason: `Blocked: sensitive API access detected (${pattern.source})`,
            warnings,
          };
        }
      }
    }

    // Check for network requests
    if (this.config.blockNetworkRequests) {
      for (const pattern of NETWORK_REQUEST_PATTERNS) {
        if (pattern.test(code)) {
          return {
            allowed: false,
            reason: `Blocked: network request pattern detected (${pattern.source})`,
            warnings,
          };
        }
      }
    }

    // Check for storage access
    if (this.config.blockStorageAccess) {
      for (const pattern of STORAGE_ACCESS_PATTERNS) {
        if (pattern.test(code)) {
          return {
            allowed: false,
            reason: `Blocked: storage modification detected (${pattern.source})`,
            warnings,
          };
        }
      }
    }

    // Check for cookie access
    if (this.config.blockCookieAccess) {
      for (const pattern of COOKIE_ACCESS_PATTERNS) {
        if (pattern.test(code)) {
          return {
            allowed: false,
            reason: `Blocked: cookie access detected (${pattern.source})`,
            warnings,
          };
        }
      }
    }

    // Block indirect API access patterns that bypass direct pattern matching
    const INDIRECT_ACCESS_PATTERNS = [
      // Bracket notation: window['fetch'], globalThis["XMLHttpRequest"]
      /(?:window|self|globalThis|top|parent|frames)\s*\[\s*['"`]/i,
      // String concatenation to build API names: "fe" + "tch"
      /['"`][a-z]{1,6}['"`]\s*\+\s*['"`][a-z]{1,8}['"`]/i,
      // Reflect/Proxy-based access
      /\bReflect\s*\.\s*(?:get|apply|construct)\b/i,
      /\bnew\s+Proxy\s*\(/i,
      // import() dynamic imports
      /\bimport\s*\(/i,
      // String.fromCharCode / fromCodePoint can reconstruct blocked API names
      /String\s*\.\s*from(?:CharCode|CodePoint)\s*\(/i,
      // Prototype chain abuse: constructor.constructor("return fetch")()
      /\.constructor\s*\.\s*constructor\s*\(/i,
      /\.constructor\s*\(/i,
      // setTimeout/setInterval with Function or string argument (deferred eval bypass)
      /(?:setTimeout|setInterval)\s*\(\s*(?:new\s+)?Function/i,
      /(?:setTimeout|setInterval)\s*\(\s*['"`]/i,
      // Cross-origin manipulation via location/domain
      /\bdocument\s*\.\s*domain\s*=/i,
      /\bwindow\s*\.\s*location\s*\.\s*(?:href|assign|replace)\s*=/i,
      // Object introspection for sandbox escape
      /Object\s*\.\s*(?:getOwnPropertyNames|getOwnPropertyDescriptor|getPrototypeOf)\s*\(\s*(?:window|self|globalThis)/i,
    ];
    for (const pattern of INDIRECT_ACCESS_PATTERNS) {
      if (pattern.test(code)) {
        return {
          allowed: false,
          reason: `Blocked: indirect API access pattern detected (${pattern.source})`,
          warnings,
        };
      }
    }

    // Block eval() and Function constructor — these enable arbitrary code execution
    // that bypasses all pattern-based validation above
    if (/\beval\s*\(/i.test(code)) {
      return {
        allowed: false,
        reason: "Blocked: eval() usage detected — nested eval bypasses security validation",
        warnings,
      };
    }
    if (/\bFunction\s*\(/i.test(code)) {
      return {
        allowed: false,
        reason: "Blocked: Function constructor detected — enables arbitrary code execution",
        warnings,
      };
    }

    // Additional warning-level checks (not blocking, but logged)
    if (/\.innerHTML\s*=/i.test(code)) {
      warnings.push("Warning: innerHTML assignment detected - potential XSS");
    }
    if (/document\.write/i.test(code)) {
      warnings.push("Warning: document.write usage detected");
    }

    return {
      allowed: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Log an evaluation attempt.
   */
  logEvaluation(opts: {
    code: string;
    allowed: boolean;
    reason?: string;
    warnings?: string[];
    targetId?: string;
    ref?: string;
  }): void {
    if (!this.config.logEvaluations) {
      return;
    }

    const entry: EvalLogEntry = {
      id: `eval-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: Date.now(),
      code: opts.code.slice(0, 500), // Truncate for logging
      allowed: opts.allowed,
      reason: opts.reason,
      warnings: opts.warnings,
      targetId: opts.targetId,
      ref: opts.ref,
    };

    this.evalLog.push(entry);

    // Trim log if too large
    if (this.evalLog.length > this.maxLogSize) {
      this.evalLog = this.evalLog.slice(-this.maxLogSize / 2);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Add a listener for evaluation attempts.
   */
  onEvaluation(listener: (entry: EvalLogEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Get recent evaluation log.
   */
  getEvalLog(limit = 100, blockedOnly = false): EvalLogEntry[] {
    let log = this.evalLog;
    if (blockedOnly) {
      log = log.filter((e) => !e.allowed);
    }
    return log.slice(-limit);
  }

  /**
   * Get statistics about evaluations.
   */
  getStats(): {
    totalAttempts: number;
    allowedAttempts: number;
    blockedAttempts: number;
    byReason: Record<string, number>;
  } {
    const stats = {
      totalAttempts: this.evalLog.length,
      allowedAttempts: 0,
      blockedAttempts: 0,
      byReason: {} as Record<string, number>,
    };

    for (const entry of this.evalLog) {
      if (entry.allowed) {
        stats.allowedAttempts++;
      } else {
        stats.blockedAttempts++;
        const reason = entry.reason ?? "unknown";
        stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
      }
    }

    return stats;
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<EvalSecurityConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): EvalSecurityConfig {
    return { ...this.config };
  }
}

// Singleton instance
let browserEvalSecurity: BrowserEvalSecurity | null = null;

/**
 * Get the singleton browser eval security instance.
 */
export function getBrowserEvalSecurity(): BrowserEvalSecurity {
  if (!browserEvalSecurity) {
    browserEvalSecurity = new BrowserEvalSecurity();
  }
  return browserEvalSecurity;
}

/**
 * Validate code for browser evaluation.
 */
export function validateBrowserEval(code: string): EvalValidationResult {
  return getBrowserEvalSecurity().validate(code);
}

/**
 * Validate and log a browser evaluation attempt.
 * Throws an error if validation fails.
 */
export function assertBrowserEvalAllowed(opts: {
  code: string;
  targetId?: string;
  ref?: string;
}): void {
  const security = getBrowserEvalSecurity();
  const result = security.validate(opts.code);

  security.logEvaluation({
    code: opts.code,
    allowed: result.allowed,
    reason: result.reason,
    warnings: result.warnings,
    targetId: opts.targetId,
    ref: opts.ref,
  });

  if (!result.allowed) {
    throw new Error(
      `Browser evaluate blocked: ${result.reason}. ` +
        `This security measure prevents potentially dangerous JavaScript execution. ` +
        `If this code is safe and necessary, contact your administrator.`,
    );
  }
}
