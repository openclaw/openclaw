import type { SafetyGuardConfig } from "./types.js";

/**
 * Safety guards to prevent dangerous operations.
 */
export class SafetyGuards {
  private config: SafetyGuardConfig;

  constructor(config?: Partial<SafetyGuardConfig>) {
    this.config = {
      payments: config?.payments ?? true,
      userData: config?.userData ?? true,
      destructive: config?.destructive ?? true,
      externalApi: config?.externalApi ?? false,
    };
  }

  /**
   * Checks if an operation is allowed.
   */
  isAllowed(operation: string, context?: Record<string, unknown>): {
    allowed: boolean;
    reason?: string;
  } {
    const opLower = operation.toLowerCase();

    // Payment operations
    if (this.config.payments && this.isPaymentOperation(opLower)) {
      return {
        allowed: false,
        reason: "Payment operations require explicit approval",
      };
    }

    // User data operations
    if (this.config.userData && this.isUserDataOperation(opLower, context)) {
      return {
        allowed: false,
        reason: "User data operations require explicit approval",
      };
    }

    // Destructive operations
    if (this.config.destructive && this.isDestructiveOperation(opLower)) {
      return {
        allowed: false,
        reason: "Destructive operations require explicit approval",
      };
    }

    // External API operations
    if (this.config.externalApi && this.isExternalApiOperation(opLower)) {
      return {
        allowed: false,
        reason: "External API operations require explicit approval",
      };
    }

    return { allowed: true };
  }

  /**
   * Checks if operation involves payments.
   */
  private isPaymentOperation(operation: string): boolean {
    const paymentKeywords = [
      "payment",
      "charge",
      "billing",
      "invoice",
      "transaction",
      "purchase",
      "buy",
      "sell",
      "refund",
      "stripe",
      "paypal",
      "checkout",
    ];

    return paymentKeywords.some((keyword) => operation.includes(keyword));
  }

  /**
   * Checks if operation involves user data.
   */
  private isUserDataOperation(
    operation: string,
    context?: Record<string, unknown>,
  ): boolean {
    const userDataKeywords = [
      "user data",
      "personal information",
      "email",
      "phone",
      "address",
      "password",
      "credit card",
      "ssn",
      "social security",
    ];

    const hasKeyword = userDataKeywords.some((keyword) =>
      operation.includes(keyword),
    );

    // Check context for user data indicators
    if (context) {
      const contextStr = JSON.stringify(context).toLowerCase();
      const hasContextKeyword = userDataKeywords.some((keyword) =>
        contextStr.includes(keyword),
      );
      return hasKeyword || hasContextKeyword;
    }

    return hasKeyword;
  }

  /**
   * Checks if operation is destructive.
   */
  private isDestructiveOperation(operation: string): boolean {
    const destructiveKeywords = [
      "delete",
      "remove",
      "drop",
      "destroy",
      "wipe",
      "clear",
      "truncate",
      "format",
      "reset",
      "uninstall",
    ];

    return destructiveKeywords.some((keyword) => operation.includes(keyword));
  }

  /**
   * Checks if operation involves external APIs.
   */
  private isExternalApiOperation(operation: string): boolean {
    const apiKeywords = [
      "api call",
      "http request",
      "fetch",
      "post",
      "put",
      "patch",
      "external",
    ];

    return apiKeywords.some((keyword) => operation.includes(keyword));
  }
}
