/**
 * Authentication flow for Telegram GramJS user accounts.
 *
 * Handles interactive login via:
 * 1. Phone number
 * 2. SMS code
 * 3. 2FA password (if enabled)
 *
 * Returns StringSession for persistence.
 */

import readline from "readline";
import { GramJSClient } from "./client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AuthState } from "./types.js";

const log = createSubsystemLogger("telegram-gramjs:auth");

/**
 * Interactive authentication flow for CLI.
 */
export class AuthFlow {
  private state: AuthState = { phase: "phone" };
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /**
   * Prompt user for input.
   */
  private async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        resolve(answer.trim());
      });
    });
  }

  /**
   * Validate phone number format.
   */
  private validatePhoneNumber(phone: string): boolean {
    // Remove spaces and dashes
    const cleaned = phone.replace(/[\s-]/g, "");
    // Should start with + and contain only digits after
    return /^\+\d{10,15}$/.test(cleaned);
  }

  /**
   * Run the complete authentication flow.
   */
  async authenticate(apiId: number, apiHash: string, sessionString?: string): Promise<string> {
    try {
      log.info("Starting Telegram authentication flow...");
      log.info("You will need:");
      log.info("  1. Your phone number (format: +1234567890)");
      log.info("  2. Access to SMS for verification code");
      log.info("  3. Your 2FA password (if enabled)");
      log.info("");

      const client = new GramJSClient({
        apiId,
        apiHash,
        sessionString,
      });

      this.state.phase = "phone";
      const phoneNumber = await this.promptPhoneNumber();
      this.state.phoneNumber = phoneNumber;

      this.state.phase = "code";
      const finalSessionString = await client.startWithAuth({
        phoneNumber: async () => phoneNumber,
        phoneCode: async () => {
          return await this.promptSmsCode();
        },
        password: async () => {
          return await this.prompt2faPassword();
        },
        onError: (err) => {
          log.error("Authentication error:", err.message);
          this.state.phase = "error";
          this.state.error = err.message;
        },
      });

      this.state.phase = "complete";
      await client.disconnect();
      this.rl.close();

      log.success("✅ Authentication successful!");
      log.info("Session string generated. This will be saved to your config.");
      log.info("");

      return finalSessionString;
    } catch (err) {
      this.state.phase = "error";
      this.state.error = err instanceof Error ? err.message : String(err);
      this.rl.close();
      throw err;
    }
  }

  /**
   * Prompt for phone number with validation.
   */
  private async promptPhoneNumber(): Promise<string> {
    while (true) {
      const phone = await this.prompt("Enter your phone number (format: +1234567890): ");

      if (this.validatePhoneNumber(phone)) {
        return phone;
      }

      log.error("❌ Invalid phone number format. Must start with + and contain 10-15 digits.");
      log.info("Example: +12025551234");
    }
  }

  /**
   * Prompt for SMS verification code.
   */
  private async promptSmsCode(): Promise<string> {
    log.info("📱 A verification code has been sent to your phone via SMS.");
    const code = await this.prompt("Enter the verification code: ");
    return code.replace(/[\s-]/g, ""); // Remove spaces/dashes
  }

  /**
   * Prompt for 2FA password (if enabled).
   */
  private async prompt2faPassword(): Promise<string> {
    log.info("🔒 Your account has Two-Factor Authentication enabled.");
    const password = await this.prompt("Enter your 2FA password: ");
    return password;
  }

  /**
   * Get current authentication state.
   */
  getState(): AuthState {
    return { ...this.state };
  }

  /**
   * Non-interactive authentication (for programmatic use).
   * Throws if user interaction is required.
   */
  static async authenticateNonInteractive(
    apiId: number,
    apiHash: string,
    sessionString: string,
  ): Promise<boolean> {
    const client = new GramJSClient({
      apiId,
      apiHash,
      sessionString,
    });

    try {
      await client.connect();
      const state = await client.getConnectionState();
      await client.disconnect();
      return state.authorized;
    } catch (err) {
      log.error("Non-interactive auth failed:", err);
      return false;
    }
  }
}

/**
 * Run interactive authentication flow (for CLI use).
 */
export async function runAuthFlow(
  apiId: number,
  apiHash: string,
  sessionString?: string,
): Promise<string> {
  const auth = new AuthFlow();
  return await auth.authenticate(apiId, apiHash, sessionString);
}

/**
 * Verify an existing session is still valid.
 */
export async function verifySession(
  apiId: number,
  apiHash: string,
  sessionString: string,
): Promise<boolean> {
  return await AuthFlow.authenticateNonInteractive(apiId, apiHash, sessionString);
}
