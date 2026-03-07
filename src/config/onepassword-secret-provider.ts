/**
 * 1Password secrets provider — uses the `op` CLI.
 *
 * Resolves secrets via `op read op://vault/item/field`.
 * Supports both signed-in sessions and service account tokens (OP_SERVICE_ACCOUNT_TOKEN).
 *
 * Config example:
 * ```json
 * { "secrets": { "providers": { "1password": { "vault": "OpenClaw" } } } }
 * ```
 *
 * Usage: `${1password:slack-bot-token}` → `op read op://OpenClaw/slack-bot-token/credential`
 *
 * Setup:
 * ```bash
 * # Install: https://developer.1password.com/docs/cli/get-started/
 * # Sign in (interactive):
 * op signin
 * # Or use a service account token (CI/headless):
 * export OP_SERVICE_ACCOUNT_TOKEN="ops_..."
 * ```
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecretProvider } from "./secret-resolution.js";

const execFileAsync = promisify(execFile);

export interface OnePasswordProviderConfig {
  /** 1Password vault name. Defaults to "OpenClaw". */
  vault?: string;
  /** Default field to read. Defaults to "credential". */
  field?: string;
}

export class OnePasswordSecretProvider implements SecretProvider {
  public readonly name = "1password";
  private readonly vault: string;
  private readonly field: string;
  private opChecked = false;

  constructor(config: OnePasswordProviderConfig = {}) {
    this.vault = config.vault ?? "OpenClaw";
    this.field = config.field ?? "credential";
  }

  async getSecret(name: string, _version?: string): Promise<string> {
    await this.ensureOp();

    // Secret name can be a full op:// URI or just an item name
    const uri = name.startsWith("op://") ? name : `op://${this.vault}/${name}/${this.field}`;

    try {
      const { stdout } = await execFileAsync("op", ["read", uri], {
        timeout: 30_000,
      });
      return stdout.trimEnd();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("isn't an item") || msg.includes("could not be found")) {
        throw new Error(`Secret "${name}" not found in 1Password vault "${this.vault}"`, {
          cause: err,
        });
      }
      throw new Error(`Failed to read secret "${name}" from 1Password: ${msg}`, { cause: err });
    }
  }

  async setSecret(_name: string, _value: string): Promise<void> {
    throw new Error("OnePasswordSecretProvider.setSecret is not yet implemented");
  }

  async listSecrets(): Promise<string[]> {
    await this.ensureOp();
    try {
      const { stdout } = await execFileAsync("op", [
        "item",
        "list",
        "--vault",
        this.vault,
        "--format",
        "json",
      ]);
      const items = JSON.parse(stdout) as Array<{ title: string }>;
      return items.map((i) => i.title).toSorted();
    } catch {
      throw new Error(`Failed to list items in 1Password vault "${this.vault}"`);
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await execFileAsync("op", ["whoami"], { timeout: 10_000 });
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async ensureOp(): Promise<void> {
    if (this.opChecked) {
      return;
    }
    try {
      await execFileAsync("which", ["op"]);
      this.opChecked = true;
    } catch {
      throw new Error(
        "1Password CLI (`op`) not found. Install it: https://developer.1password.com/docs/cli/get-started/",
      );
    }
  }
}
