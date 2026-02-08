/**
 * Exec Denylist - Defense-in-depth against dangerous command execution
 * 
 * This module provides a configurable denylist of commands that should never
 * be executed, even if they pass other safety checks. This is a defense-in-depth
 * measure to protect against potential command injection vulnerabilities.
 */

// Default dangerous commands - truly exact matches only
// (Patterns handle variants with different quoting/spacing/flags)
const DEFAULT_DANGEROUS_COMMANDS = new Set([
  // System destruction - exact forms
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf ~/*',
  'rm -fr /',
  'rm -fr /*',
  ':(){:|:&};:',  // Fork bomb (exact classic form)
  
  // Dangerous utilities without args
  'xmrig',
  'minerd', 
  'cpuminer',
]);

// Default patterns that indicate potentially dangerous commands
const DEFAULT_DANGEROUS_PATTERNS: RegExp[] = [
  // Reverse shells
  /bash\s+-i\s+>&?\s*\/dev\/tcp/i,
  /nc\s+(-e|--exec)/i,
  /ncat\s+(-e|--exec)/i,
  /python[23]?\s+-c\s+["']?\s*import\s+(socket|pty|os)/i,
  /perl\s+-e\s+["'].*socket/i,
  /ruby\s+-rsocket/i,
  /php\s+-r\s+["'].*fsockopen/i,
  /socat\s+.*exec:/i,
  
  // Data exfiltration via pipe to shell
  /curl\s+.*\|\s*(sh|bash|zsh)/i,
  /wget\s+.*\|\s*(sh|bash|zsh)/i,
  /curl\s+.*-o\s*-\s*\|\s*(sh|bash)/i,
  
  // Fork bombs (various forms)
  /:\(\)\s*\{.*:\s*\|\s*:.*\}\s*;?\s*:/,
  /bomb\s*\(\)\s*\{.*bomb\s*\|\s*bomb/i,
  
  // Recursive deletion from root - stricter matching
  // Matches: rm -rf /, rm -rf / *, rm -rf /*, rm --recursive /, etc.
  /rm\s+(-[rf]{2,}|--recursive\s+-f|--force\s+--recursive)\s+\/(\s|$|\*)/i,
  /rm\s+(-[rf]{2,}|--recursive\s+-f|--force\s+--recursive)\s+["']?\/["']?(\s|$)/i,
  
  // Format commands on system drives
  /mkfs(\.\w+)?\s+\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z])/i,
  
  // dd to disk devices
  /dd\s+.*of=\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z])/i,
  /dd\s+.*if=\/dev\/(zero|random|urandom).*of=\//i,
  
  // Credential theft
  /cat\s+(\/etc\/shadow|\/etc\/passwd)/i,
  /less\s+(\/etc\/shadow)/i,
  /head\s+(\/etc\/shadow)/i,
  /tail\s+(\/etc\/shadow)/i,
  
  // Dangerous chmod
  /chmod\s+(-R\s+)?777\s+\//,
  /chmod\s+(-R\s+)?[0-7]*777[0-7]*\s+\//,
];

// Commands that require elevated scrutiny (warn but don't block by default)
const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /sudo\s+/i,
  /su\s+-/i,
  /chmod\s+[0-7]{3,4}/i,
  /chown\s+/i,
  /iptables\s+/i,
  /systemctl\s+(stop|disable|mask)/i,
  /pkill\s+/i,
  /killall\s+/i,
];

export type DenylistCheckResult = {
  blocked: boolean;
  reason?: string;
  sensitive?: boolean;
  sensitiveReason?: string;
};

export type DenylistConfig = {
  commands?: Set<string>;
  patterns?: RegExp[];
  sensitivePatterns?: RegExp[];
};

/**
 * Create a denylist checker instance with isolated state.
 * This avoids global mutation and allows different configs per context.
 */
export function createDenylist(config: DenylistConfig = {}) {
  const commands = config.commands ?? new Set(DEFAULT_DANGEROUS_COMMANDS);
  const patterns = config.patterns ?? [...DEFAULT_DANGEROUS_PATTERNS];
  const sensitivePatterns = config.sensitivePatterns ?? [...DEFAULT_SENSITIVE_PATTERNS];

  /**
   * Check if a command is on the denylist
   */
  function checkCommand(command: string): DenylistCheckResult {
    const trimmed = command.trim();
    
    // Check exact matches first
    if (commands.has(trimmed)) {
      return {
        blocked: true,
        reason: `Command "${trimmed}" is on the security denylist`,
      };
    }
    
    // Check dangerous patterns
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        return {
          blocked: true,
          reason: `Command matches dangerous pattern: ${pattern.source}`,
        };
      }
    }
    
    // Check sensitive patterns (warn but don't block)
    for (const pattern of sensitivePatterns) {
      if (pattern.test(trimmed)) {
        return {
          blocked: false,
          sensitive: true,
          sensitiveReason: `Command matches sensitive pattern: ${pattern.source}`,
        };
      }
    }
    
    return { blocked: false };
  }

  /**
   * Split compound command into subcommands, respecting shell syntax.
   * Splits on: ; (sequence), && (and), || (or), | (pipe)
   * Does NOT split on: & (background), redirections like 2>&1
   */
  function splitCompoundCommand(command: string): string[] {
    const subcommands: string[] = [];
    let current = '';
    let i = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    
    while (i < command.length) {
      const char = command[i];
      const nextChar = command[i + 1];
      
      // Track quote state
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += char;
        i++;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += char;
        i++;
        continue;
      }
      
      // Only split when not inside quotes
      if (!inSingleQuote && !inDoubleQuote) {
        // Check for && or ||
        if ((char === '&' && nextChar === '&') || (char === '|' && nextChar === '|')) {
          if (current.trim()) subcommands.push(current.trim());
          current = '';
          i += 2;
          continue;
        }
        
        // Check for ; (command separator)
        if (char === ';') {
          if (current.trim()) subcommands.push(current.trim());
          current = '';
          i++;
          continue;
        }
        
        // Check for single | (pipe) - but not ||
        if (char === '|' && nextChar !== '|') {
          if (current.trim()) subcommands.push(current.trim());
          current = '';
          i++;
          continue;
        }
        
        // Skip & when it's part of redirection like 2>&1
        if (char === '&' && nextChar !== '&') {
          // Check if this looks like a redirection (digit before &)
          const prevChar = i > 0 ? command[i - 1] : '';
          if (prevChar >= '0' && prevChar <= '9') {
            // Part of redirection like 2>&1, keep it
            current += char;
            i++;
            continue;
          }
          // Background operator - treat as separator
          if (current.trim()) subcommands.push(current.trim());
          current = '';
          i++;
          continue;
        }
      }
      
      current += char;
      i++;
    }
    
    if (current.trim()) subcommands.push(current.trim());
    return subcommands;
  }

  /**
   * Check if a command contains any blocked subcommands
   * (for compound commands with ; | && ||)
   */
  function checkCompoundCommand(command: string): DenylistCheckResult {
    const subcommands = splitCompoundCommand(command);
    
    for (const sub of subcommands) {
      const result = checkCommand(sub);
      if (result.blocked) {
        return result;
      }
    }
    
    // Also check the full command (catches patterns spanning subcommands)
    return checkCommand(command);
  }

  /**
   * Add a custom pattern to this denylist instance
   */
  function addPattern(pattern: RegExp): void {
    patterns.push(pattern);
  }

  /**
   * Add a custom command to this denylist instance
   */
  function addCommand(command: string): void {
    commands.add(command.trim());
  }

  /**
   * Reset to default patterns/commands
   */
  function reset(): void {
    commands.clear();
    DEFAULT_DANGEROUS_COMMANDS.forEach(cmd => commands.add(cmd));
    patterns.length = 0;
    patterns.push(...DEFAULT_DANGEROUS_PATTERNS);
    sensitivePatterns.length = 0;
    sensitivePatterns.push(...DEFAULT_SENSITIVE_PATTERNS);
  }

  return {
    checkCommand,
    checkCompoundCommand,
    splitCompoundCommand,
    addPattern,
    addCommand,
    reset,
  };
}

// Default instance for backwards compatibility
const defaultDenylist = createDenylist();

/**
 * Check if a command is on the denylist (uses default instance)
 */
export function checkCommandDenylist(command: string): DenylistCheckResult {
  return defaultDenylist.checkCommand(command);
}

/**
 * Check compound command (uses default instance)
 */
export function checkCompoundCommandDenylist(command: string): DenylistCheckResult {
  return defaultDenylist.checkCompoundCommand(command);
}

/**
 * @deprecated Use createDenylist() for isolated instances instead
 */
export function addDenylistPattern(pattern: RegExp): void {
  defaultDenylist.addPattern(pattern);
}

/**
 * @deprecated Use createDenylist() for isolated instances instead
 */
export function addDenylistCommand(command: string): void {
  defaultDenylist.addCommand(command);
}
