/**
 * Masked Secrets — Public API
 *
 * Prevents agents from accessing raw API keys and secrets.
 * Provides three layers of protection:
 *
 * 1. **Substitution**: Agent writes {{secret:NAME}}, runtime injects real value
 * 2. **Preflight**: Block commands that dump env vars or read secret files
 * 3. **Redaction**: Scrub leaked secrets from command output before agent sees it
 *
 * @example
 * ```ts
 * import { createMaskedSecrets } from "./security/masked-secrets/index.js";
 *
 * const ms = createMaskedSecrets({ mask: ["OPENAI_API_KEY", "GITHUB_TOKEN"] });
 *
 * // Before command execution:
 * const preflight = ms.preflight("curl -H 'Auth: {{secret:OPENAI_API_KEY}}' ...");
 * if (!preflight.allowed) { reject(preflight.reason); }
 * const realCommand = preflight.processedCommand;
 *
 * // After command output:
 * const { text: safeOutput } = ms.redact(rawOutput);
 * // safeOutput has all secret values replaced with [REDACTED]
 * ```
 *
 * @see https://github.com/openclaw/openclaw/issues/10659
 */

export { SecretStore } from "./secret-store.js";
export { substituteSecrets, hasSecretRefs, extractSecretRefs } from "./substitution.js";
export { redactOutput } from "./redaction.js";
export { preflightCheck } from "./preflight.js";
export type {
  MaskedSecret,
  MaskedSecretsConfig,
  SubstitutionResult,
  RedactionResult,
  PreflightResult,
} from "./types.js";

import { preflightCheck } from "./preflight.js";
import { redactOutput } from "./redaction.js";
import { SecretStore } from "./secret-store.js";
import type { MaskedSecretsConfig, PreflightResult, RedactionResult } from "./types.js";

/**
 * High-level facade for the masked secrets system.
 * Create one instance at gateway startup, use it throughout the lifecycle.
 */
export class MaskedSecrets {
  private store: SecretStore;

  constructor(config?: Partial<MaskedSecretsConfig>) {
    this.store = new SecretStore(config);
    this.store.load();
  }

  /** Run preflight checks and substitution on a command */
  preflight(command: string): PreflightResult {
    if (!this.store.getConfig().enabled) {
      return { allowed: true, processedCommand: command };
    }
    return preflightCheck(command, this.store);
  }

  /** Redact secrets from command output */
  redact(output: string): RedactionResult {
    if (!this.store.getConfig().enabled) {
      return { text: output, count: 0, redactedSecrets: [] };
    }
    return redactOutput(output, this.store);
  }

  /** Get list of masked secret names (not values!) */
  listSecretNames(): string[] {
    return this.store.listNames();
  }

  /** Check if the system is enabled */
  isEnabled(): boolean {
    return this.store.getConfig().enabled;
  }

  /** Reload secrets (e.g., after config change) */
  reload(config?: Partial<MaskedSecretsConfig>): void {
    if (config) {
      this.store.updateConfig(config);
    } else {
      this.store.load();
    }
  }

  /** Get the underlying store (for testing) */
  getStore(): SecretStore {
    return this.store;
  }
}

/**
 * Factory function for creating a MaskedSecrets instance.
 * Preferred over direct constructor for clarity.
 */
export function createMaskedSecrets(config?: Partial<MaskedSecretsConfig>): MaskedSecrets {
  return new MaskedSecrets(config);
}
