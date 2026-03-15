/**
 * Credential Broker - Agent-blind credential injection.
 *
 * Intercepts tool execution to resolve credential references like
 * "secret:<name>" before the tool receives the parameters.
 *
 * Supports deep traversal to find credentialRef fields in nested objects/arrays.
 */

import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { auditLog } from "./audit-log.js";
import { getSecret } from "./index.js";

/**
 * Resolved credential reference.
 */
export interface ResolvedCredential {
  /** Original reference (e.g., "secret:github_token") */
  ref: string;
  /** Resolved secret value */
  value: string;
  /** Secret name (without "secret:" prefix) */
  name: string;
}

/**
 * Credential Broker for agent-blind credential injection.
 */
export class CredentialBroker {
  private config: OpenClawConfig;

  constructor(config?: OpenClawConfig) {
    this.config = config ?? loadConfig();
  }

  /**
   * Check if broker is enabled for a given tool.
   * @param toolName Tool name
   * @returns True if broker should intercept this tool
   */
  isEnabled(toolName: string): boolean {
    const brokerConfig = this.config.security?.credentials?.broker;

    if (!brokerConfig?.enabled) {
      return false;
    }

    // If no interceptTools specified, intercept all tools
    if (!brokerConfig.interceptTools || brokerConfig.interceptTools.length === 0) {
      return true;
    }

    // Check if tool is in intercept list
    return brokerConfig.interceptTools.includes(toolName);
  }

  /**
   * Resolve a credential reference.
   * @param ref Credential reference (e.g., "secret:github_token")
   * @returns Resolved credential with value
   * @throws Error if ref is invalid, secret not found, or grant expired
   */
  async resolve(ref: string, toolName?: string): Promise<ResolvedCredential> {
    // Validate reference format
    if (!ref.startsWith("secret:")) {
      throw new Error(`Invalid credential reference: ${ref} (must start with "secret:")`);
    }

    // Extract secret name
    const name = ref.slice(7); // Remove "secret:" prefix

    if (!name || name.length === 0) {
      throw new Error(`Invalid credential reference: ${ref} (empty secret name)`);
    }

    // Enforce per-tool credential allowlist
    if (toolName) {
      const allowedSecrets = this.config.security?.credentials?.broker?.toolAllowedSecrets;
      if (allowedSecrets && allowedSecrets[toolName]) {
        if (!allowedSecrets[toolName].includes(name)) {
          await auditLog({
            event: "credential_denied",
            name,
            tool: toolName,
            timestamp: Date.now(),
            details: { reason: `Secret '${name}' not in allowlist for tool '${toolName}'`, ref },
          });
          throw new Error(`Secret '${name}' is not allowed for tool '${toolName}'`);
        }
      }
    }

    // Resolve via getSecret (validates grant and tier)
    try {
      const value = await getSecret(name);

      return { ref, value, name };
    } catch (error) {
      // Log denial
      await auditLog({
        event: "credential_denied",
        name,
        timestamp: Date.now(),
        details: {
          reason: error instanceof Error ? error.message : String(error),
          ref,
        },
      });

      throw error;
    }
  }

  /**
   * Inject credentials into tool parameters.
   * Deep clones params and recursively replaces credentialRef fields with resolved values.
   *
   * @param toolName Tool name (for audit logging)
   * @param params Original tool parameters
   * @returns New params object with credentials injected
   */
  async inject(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Pass-through if broker disabled for this tool
    if (!this.isEnabled(toolName)) {
      return params;
    }

    // Deep clone to avoid mutating original
    const injected = structuredClone(params);

    // Recursively find and replace credentialRef fields
    await this.injectRecursive(toolName, injected);

    return injected;
  }

  /**
   * Recursively inject credentials into an object/array.
   * @param toolName Tool name (for audit logging)
   * @param obj Object or array to process
   */
  private async injectRecursive(toolName: string, obj: unknown): Promise<void> {
    if (obj === null || typeof obj !== "object") {
      return;
    }

    if (Array.isArray(obj)) {
      // Process array elements
      for (const item of obj) {
        await this.injectRecursive(toolName, item);
      }
      return;
    }

    // Process object entries
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "credentialRef" && typeof value === "string") {
        // Found a credential reference — resolve and replace
        const resolved = await this.resolve(value, toolName);

        // Log resolution
        await auditLog({
          event: "credential_resolved",
          name: resolved.name,
          tool: toolName,
          timestamp: Date.now(),
          details: { ref: resolved.ref },
        });

        // Replace credentialRef with value
        const objRecord = obj as Record<string, unknown>;
        delete objRecord.credentialRef;
        objRecord.value = resolved.value;
      } else if (typeof value === "object" && value !== null) {
        // Recurse into nested objects/arrays
        await this.injectRecursive(toolName, value);
      }
    }
  }
}
