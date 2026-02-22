/**
 * Bitwarden / Vaultwarden secret provider for OpenClaw.
 *
 * Uses the `bw` CLI (no SDK dependency). Supports interactive login,
 * API key auth for CI, self-hosted Vaultwarden, and per-field extraction.
 *
 * Uses execFile directly (not runExec) because BW_SESSION and other
 * credentials must be injected via env without mutating process.env.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
/**
 * SecretProvider interface matching PR #16663 (feat: GCP Secret Manager integration).
 * Once that PR lands, replace this with: import type { SecretProvider } from "./secret-resolution.js"
 * See: https://github.com/openclaw/openclaw/pull/16663
 */
export interface SecretProvider {
  name: string;
  getSecret(name: string, version?: string): Promise<string>;
  setSecret(name: string, value: string): Promise<void>;
  listSecrets(): Promise<string[]>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

const execFileAsync = promisify(execFileCb);

export interface BitwardenProviderConfig {
  sessionKey?: string;
  collectionId?: string;
  serverUrl?: string;
  clientId?: string;
  clientSecret?: string;
  cacheTtlSeconds?: number;
}

export class BitwardenCliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "BitwardenCliError";
  }
}

interface BitwardenLoginField {
  username?: string | null;
  password?: string | null;
  uris?: Array<{ uri: string }>;
}

interface BitwardenCustomField {
  name: string;
  value: string;
  type: number;
}

interface BitwardenItem {
  id: string;
  name: string;
  type: number;
  login?: BitwardenLoginField;
  notes?: string | null;
  fields?: BitwardenCustomField[];
}

type CacheEntry = { value: string; expiresAt: number };
const localCache = new Map<string, CacheEntry>();

export function clearBitwardenSecretCache(): void {
  localCache.clear();
}

export class BitwardenSecretProvider implements SecretProvider {
  public readonly name = "bw";
  private readonly collectionId?: string;
  private readonly envOverrides: Record<string, string>;
  public readonly cacheTtlMs: number;

  constructor(config: BitwardenProviderConfig) {
    this.collectionId = config.collectionId;
    this.cacheTtlMs = (config.cacheTtlSeconds ?? 300) * 1000;

    // Build env overrides without mutating process.env globally
    const env: Record<string, string> = {};
    if (config.sessionKey) {
      env.BW_SESSION = config.sessionKey;
    }
    if (config.clientId) {
      env.BW_CLIENTID = config.clientId;
    }
    if (config.clientSecret) {
      env.BW_CLIENTSECRET = config.clientSecret;
    }
    if (config.serverUrl) {
      env.BW_URL = config.serverUrl;
    }
    this.envOverrides = env;
  }

  private async runBw(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("bw", [...args, "--nointeraction", "--raw"], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, ...this.envOverrides },
      });
      return stdout.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw this.mapCliError(msg);
    }
  }

  private mapCliError(msg: string): BitwardenCliError {
    if (msg.includes("not found") || msg.includes("ENOENT")) {
      return new BitwardenCliError(
        "Bitwarden CLI (`bw`) not found in PATH.",
        "Install: https://bitwarden.com/help/cli/ or `brew install bitwarden-cli`",
      );
    }
    if (msg.includes("not logged in") || msg.includes("You are not logged in")) {
      return new BitwardenCliError(
        "Bitwarden CLI is not logged in.",
        "Run `bw login` or configure clientId/clientSecret for API key auth.",
      );
    }
    if (msg.includes("locked") || msg.includes("Vault is locked")) {
      return new BitwardenCliError(
        "Bitwarden vault is locked.",
        "Run `bw unlock` and export BW_SESSION, or set sessionKey in secrets.providers.bw.",
      );
    }
    if (msg.includes("More than one result")) {
      return new BitwardenCliError(
        "Multiple Bitwarden items match the query. Use the item ID instead of the name.",
      );
    }
    if (msg.includes("Not found")) {
      return new BitwardenCliError("Bitwarden item not found.");
    }
    return new BitwardenCliError(`Bitwarden CLI error: ${msg}`);
  }

  /**
   * Parse a secret reference name into item query and field.
   * Format: "item-name/field-name" or just "item-name" (defaults to password).
   */
  private parseRef(name: string): { itemQuery: string; field: string } {
    const slashIdx = name.lastIndexOf("/");
    if (slashIdx === -1) {
      return { itemQuery: name, field: "password" };
    }
    return {
      itemQuery: name.substring(0, slashIdx),
      field: name.substring(slashIdx + 1),
    };
  }

  private extractField(item: BitwardenItem, field: string): string {
    switch (field) {
      case "password": {
        const pw = item.login?.password;
        if (!pw) {
          throw new BitwardenCliError(
            `Item "${item.name}" has no password field.`,
            `Available fields: ${this.listAvailableFields(item).join(", ")}`,
          );
        }
        return pw;
      }
      case "username": {
        const uname = item.login?.username;
        if (!uname) {
          throw new BitwardenCliError(
            `Item "${item.name}" has no username field.`,
            `Available fields: ${this.listAvailableFields(item).join(", ")}`,
          );
        }
        return uname;
      }
      case "notes":
        return item.notes ?? "";
      case "uri":
        return item.login?.uris?.[0]?.uri ?? "";
      default: {
        const customField = item.fields?.find((f) => f.name === field);
        if (customField) {
          return String(customField.value);
        }
        throw new BitwardenCliError(
          `Field "${field}" not found in item "${item.name}".`,
          `Available fields: ${this.listAvailableFields(item).join(", ")}`,
        );
      }
    }
  }

  private listAvailableFields(item: BitwardenItem): string[] {
    const fields: string[] = [];
    if (item.login?.password) {
      fields.push("password");
    }
    if (item.login?.username) {
      fields.push("username");
    }
    if (item.login?.uris?.length) {
      fields.push("uri");
    }
    fields.push("notes");
    if (item.fields) {
      for (const f of item.fields) {
        fields.push(f.name);
      }
    }
    return fields;
  }

  async getSecret(name: string, _version?: string): Promise<string> {
    const cacheKey = `bw:${name}`;
    const cached = localCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const { itemQuery, field } = this.parseRef(name);

    if (field === "totp") {
      const totp = await this.runBw(["get", "totp", itemQuery]);
      localCache.set(cacheKey, { value: totp, expiresAt: Date.now() + this.cacheTtlMs });
      return totp;
    }

    const raw = await this.runBw(["get", "item", itemQuery]);
    const item: BitwardenItem = JSON.parse(raw);
    const value = this.extractField(item, field);

    localCache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  async setSecret(name: string, value: string): Promise<void> {
    const { itemQuery, field } = this.parseRef(name);

    let existingItem: BitwardenItem | null = null;
    try {
      const raw = await this.runBw(["get", "item", itemQuery]);
      existingItem = JSON.parse(raw);
    } catch {
      // Item doesn't exist yet
    }

    if (existingItem) {
      this.updateItemField(existingItem, field, value);
      const encoded = Buffer.from(JSON.stringify(existingItem)).toString("base64");
      await this.runBw(["edit", "item", existingItem.id, encoded]);
    } else {
      const newItem: Record<string, unknown> = {
        organizationId: null,
        folderId: null,
        type: 1,
        name: itemQuery,
        login: {
          username: null,
          password: field === "password" ? value : null,
          uris: [],
        },
        fields:
          field !== "password" && field !== "username" ? [{ name: field, value, type: 0 }] : [],
        notes: field === "notes" ? value : null,
      };
      if (field === "username") {
        (newItem.login as Record<string, unknown>).username = value;
      }
      const encoded = Buffer.from(JSON.stringify(newItem)).toString("base64");
      await this.runBw(["create", "item", encoded]);
    }

    localCache.delete(`bw:${name}`);
  }

  private updateItemField(item: BitwardenItem, field: string, value: string): void {
    switch (field) {
      case "password": {
        const login = item.login ?? { username: null, password: null, uris: [] };
        login.password = value;
        item.login = login;
        break;
      }
      case "username": {
        const login = item.login ?? { username: null, password: null, uris: [] };
        login.username = value;
        item.login = login;
        break;
      }
      case "notes":
        item.notes = value;
        break;
      default: {
        const fields = item.fields ?? [];
        const existing = fields.find((f) => f.name === field);
        if (existing) {
          existing.value = value;
        } else {
          fields.push({ name: field, value, type: 0 });
        }
        item.fields = fields;
      }
    }
  }

  async listSecrets(): Promise<string[]> {
    const args = ["list", "items"];
    if (this.collectionId) {
      args.push("--collectionid", this.collectionId);
    }
    const raw = await this.runBw(args);
    const items: BitwardenItem[] = JSON.parse(raw);
    return items.map((item) => item.name);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const statusRaw = await this.runBw(["status"]);
      const status = JSON.parse(statusRaw) as { status: string; serverUrl?: string | null };

      if (status.status === "unauthenticated") {
        return { ok: false, error: "Not logged in. Run `bw login` first." };
      }
      if (status.status === "locked") {
        return { ok: false, error: "Vault is locked. Run `bw unlock` and export BW_SESSION." };
      }

      await this.runBw(["sync"]);
      return { ok: true };
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
