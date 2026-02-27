/**
 * Environment variable secrets provider.
 *
 * Resolves secrets from environment variables — useful as a simple local-dev
 * fallback or for CI pipelines that inject secrets via env.
 *
 * Config example:
 * ```json
 * { "secrets": { "providers": { "env": {} } } }
 * ```
 *
 * Usage: `${env:SLACK_BOT_TOKEN}` resolves to `process.env.SLACK_BOT_TOKEN`.
 */

import type { SecretProvider } from "./secret-resolution.js";

export class EnvSecretProvider implements SecretProvider {
  public readonly name = "env";
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async getSecret(name: string, _version?: string): Promise<string> {
    const value = this.env[name];
    if (value === undefined || value === "") {
      throw new Error(`Environment variable "${name}" is not set or empty`);
    }
    return value;
  }

  async setSecret(_name: string, _value: string): Promise<void> {
    throw new Error("EnvSecretProvider does not support writing secrets");
  }

  async listSecrets(): Promise<string[]> {
    return Object.keys(this.env).toSorted();
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }
}
