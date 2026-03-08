// Safe function parser - Replacement for dangerous eval usage
// Used for safely parsing and executing dynamic functions

/**
 * Safely parse and execute function strings
 * Replacement for dangerous eval() usage
 */
export class SafeFunctionParser {
  private static readonly allowedGlobals = new Set([
    // Math functions
    'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date',
    'JSON', 'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError',
    // Browser APIs (limited)
    'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    // Type checking
    'typeof', 'instanceof', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  ]);

  private static readonly dangerousPatterns = [
    // Prevent access to dangerous objects
    /window\./g,
    /document\./g,
    /localStorage/g,
    /sessionStorage/g,
    /indexedDB/g,
    /XMLHttpRequest/g,
    /fetch/g,
    /import/g,
    /require/g,
    /process\./g,
    /global\./g,
    // Prevent dangerous operations
    /\.constructor\./g,
    /\.__proto__\./g,
    /\.prototype\./g,
    /Function\(/g,
    /eval\(/g,
    // Prevent dangerous assignments (only block assignment to dangerous properties)
    /window\s*=/g,
    /document\s*=/g,
    /localStorage\s*=/g,
    /sessionStorage\s*=/g,
    /XMLHttpRequest\s*=/g,
    /fetch\s*=/g,
    // Prevent function and class definitions
    /function\s*\(/g,
    /=>/g,
    /class\s+/g,
    // Prevent new operator with dangerous constructors
    /new\s+Function/g,
    /new\s+eval/g,
  ];

  /**
   * Check if function body is safe
   */
  static isFunctionBodySafe(fnBody: string): boolean {
    if (!fnBody || typeof fnBody !== 'string') {
      return false;
    }

    // Check length limit (prevent DoS)
    if (fnBody.length > 10000) {
      console.warn('Security warning: Function body too long');
      return false;
    }

    // Check for dangerous patterns
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(fnBody)) {
        console.warn(`Security warning: Dangerous pattern found: ${pattern}`);
        return false;
      }
    }

    // Check for unauthorized global variable access
    const globalAccessMatches = fnBody.match(/[A-Za-z_$][A-Za-z0-9_$]*\./g) || [];
    for (const match of globalAccessMatches) {
      const globalName = match.slice(0, -1); // Remove trailing dot
      if (!this.allowedGlobals.has(globalName)) {
        console.warn(`Security warning: Unauthorized global access: ${globalName}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Safely create a function
   */
  static createSafeFunction(fnBody: string, argNames: string[] = ['el', 'args']): Function | null {
    if (!this.isFunctionBodySafe(fnBody)) {
      console.error('Security error: Unsafe function body');
      return null;
    }

    try {
      // Use Function constructor (slightly safer than eval, but still needs caution)
      const safeFnBody = `
        "use strict";
        try {
          ${fnBody}
        } catch (error) {
          console.error('Error in safe function:', error);
          throw error;
        }
      `;

      // eslint-disable-next-line no-new-func
      return new Function(...argNames, safeFnBody);
    } catch (error) {
      console.error('Security error: Failed to create safe function:', error);
      return null;
    }
  }

  /**
   * Safely execute a function
   */
  static executeSafeFunction(
    fnBody: string,
    context: any,
    args: any[] = [],
    timeoutMs: number = 5000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Create safe function
      const safeFn = this.createSafeFunction(fnBody);
      if (!safeFn) {
        reject(new Error('Failed to create safe function'));
        return;
      }

      // Set timeout
      const timeoutId = setTimeout(() => {
        reject(new Error(`Function execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        // Execute function
        const result = safeFn.call(context, ...args);
        
        // Handle Promise result
        if (result && typeof result.then === 'function') {
          result
            .then((resolvedResult: any) => {
              clearTimeout(timeoutId);
              resolve(resolvedResult);
            })
            .catch((error: any) => {
              clearTimeout(timeoutId);
              reject(error);
            });
        } else {
          clearTimeout(timeoutId);
          resolve(result);
        }
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Safe expression evaluation (replacement for eval("(" + expr + ")"))
   */
  static safeEvaluateExpression(expr: string): any {
    if (!this.isFunctionBodySafe(expr)) {
      throw new Error('Unsafe expression');
    }

    try {
      // Use JSON.parse for simple expressions
      if (expr.trim().startsWith('{') || expr.trim().startsWith('[')) {
        return JSON.parse(expr);
      }

      // For other expressions, use safe function wrapper
      const wrappedExpr = `return (${expr})`;
      const safeFn = this.createSafeFunction(wrappedExpr, []);
      if (!safeFn) {
        throw new Error('Failed to create safe evaluation function');
      }

      return safeFn();
    } catch (error) {
      console.error('Security error: Failed to evaluate expression:', error);
      throw error;
    }
  }
}

// Export convenience functions
export function safeEval(expr: string): any {
  return SafeFunctionParser.safeEvaluateExpression(expr);
}

export function createSafeFunction(fnBody: string, argNames?: string[]): Function | null {
  return SafeFunctionParser.createSafeFunction(fnBody, argNames);
}

export function executeSafeFunction(
  fnBody: string,
  context: any,
  args?: any[],
  timeoutMs?: number
): Promise<any> {
  return SafeFunctionParser.executeSafeFunction(fnBody, context, args, timeoutMs);
}

export default SafeFunctionParser;