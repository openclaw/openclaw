// 安全函数解析器 - 替代危险的eval使用
// 用于安全地解析和执行动态函数

/**
 * 安全地解析和执行函数字符串
 * 替代危险的eval()使用
 */
export class SafeFunctionParser {
  private static readonly allowedGlobals = new Set([
    // 数学函数
    'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date',
    'JSON', 'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError',
    // 浏览器API（有限制）
    'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    // 类型检查
    'typeof', 'instanceof', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  ]);

  private static readonly dangerousPatterns = [
    // 禁止访问危险对象
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
    // 禁止危险操作
    /\.constructor\./g,
    /\.__proto__\./g,
    /\.prototype\./g,
    /Function\(/g,
    /eval\(/g,
    // 禁止赋值操作
    /=/g,
    // 禁止函数定义
    /function\s*\(/g,
    /=>/g,
    /class\s+/g,
  ];

  /**
   * 检查函数体是否安全
   */
  static isFunctionBodySafe(fnBody: string): boolean {
    if (!fnBody || typeof fnBody !== 'string') {
      return false;
    }

    // 检查长度限制（防止DoS）
    if (fnBody.length > 10000) {
      console.warn('Security warning: Function body too long');
      return false;
    }

    // 检查危险模式
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(fnBody)) {
        console.warn(`Security warning: Dangerous pattern found: ${pattern}`);
        return false;
      }
    }

    // 检查是否包含未授权的全局变量访问
    const globalAccessMatches = fnBody.match(/[A-Za-z_$][A-Za-z0-9_$]*\./g) || [];
    for (const match of globalAccessMatches) {
      const globalName = match.slice(0, -1); // 移除末尾的点
      if (!this.allowedGlobals.has(globalName)) {
        console.warn(`Security warning: Unauthorized global access: ${globalName}`);
        return false;
      }
    }

    return true;
  }

  /**
   * 安全地创建函数
   */
  static createSafeFunction(fnBody: string, argNames: string[] = ['el', 'args']): Function | null {
    if (!this.isFunctionBodySafe(fnBody)) {
      console.error('Security error: Unsafe function body');
      return null;
    }

    try {
      // 使用Function构造函数（比eval稍安全，但仍然需要小心）
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
   * 安全地执行函数
   */
  static executeSafeFunction(
    fnBody: string,
    context: any,
    args: any[] = [],
    timeoutMs: number = 5000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // 创建安全函数
      const safeFn = this.createSafeFunction(fnBody);
      if (!safeFn) {
        reject(new Error('Failed to create safe function'));
        return;
      }

      // 设置超时
      const timeoutId = setTimeout(() => {
        reject(new Error(`Function execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        // 执行函数
        const result = safeFn.call(context, ...args);
        
        // 处理Promise结果
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
   * 安全的表达式求值（替代eval("(" + expr + ")"))
   */
  static safeEvaluateExpression(expr: string): any {
    if (!this.isFunctionBodySafe(expr)) {
      throw new Error('Unsafe expression');
    }

    try {
      // 使用JSON.parse处理简单表达式
      if (expr.trim().startsWith('{') || expr.trim().startsWith('[')) {
        return JSON.parse(expr);
      }

      // 对于其他表达式，使用安全的函数包装
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

// 导出便捷函数
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