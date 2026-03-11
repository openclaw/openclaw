import type { HyperionDynamoDBClient } from "./dynamodb-client.js";
import { DEFAULT_AGENT_ID, type UserCredentials } from "./types.js";

/**
 * Minimal KMS client interface.
 * Accepts any AWS SDK v3 KMSClient-compatible implementation.
 */
export type KMSClient = {
  send(command: unknown): Promise<unknown>;
};

/** Credential cache TTL: 2 minutes (shorter than config cache for security). */
const CREDENTIAL_CACHE_TTL_MS = 2 * 60_000;

/** Maximum credential cache entries. */
const CREDENTIAL_CACHE_MAX_SIZE = 10_000;

type CachedCredentials = {
  credentials: UserCredentials;
  cachedAt: number;
};

/**
 * Manages per-user API keys and credentials with KMS envelope encryption.
 *
 * Security model:
 * - Credentials are encrypted client-side using KMS before writing to DynamoDB.
 * - KMS encryption context includes { user_id } so one user's ciphertext
 *   cannot be decrypted with another user's context (cross-tenant isolation).
 * - DynamoDB never stores plaintext credentials.
 * - KMS key rotation is handled by AWS (enabled in CDK).
 * - Decrypted values are cached in-memory with a short TTL to avoid
 *   excessive KMS calls during high-frequency request paths.
 */
export class UserCredentialStore {
  private readonly dbClient: HyperionDynamoDBClient;
  private readonly kmsClient: KMSClient;
  private readonly kmsKeyId: string;
  private readonly cache = new Map<string, CachedCredentials>();

  constructor(dbClient: HyperionDynamoDBClient, kmsClient: KMSClient, kmsKeyId: string) {
    this.dbClient = dbClient;
    this.kmsClient = kmsClient;
    this.kmsKeyId = kmsKeyId;
  }

  /**
   * Retrieve and decrypt credentials for a user+agent.
   * [claude-infra] Multi-instance: looks up agent-specific, falls back to shared.
   * Returns null if the user has no stored credentials.
   */
  async getCredentials(
    userId: string,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<UserCredentials | null> {
    const cacheKey = `${userId}:${agentId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS) {
      return cached.credentials;
    }

    const record = await this.dbClient.getUserCredentials(userId, agentId);
    if (!record) {
      return null;
    }

    const credentials = await this.decrypt(record.credentials_blob, userId);

    if (this.cache.size >= CREDENTIAL_CACHE_MAX_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(cacheKey, { credentials, cachedAt: Date.now() });
    return credentials;
  }

  /**
   * Encrypt and store credentials for a user+agent.
   * [claude-infra] Multi-instance: stores with composite key.
   */
  async putCredentials(
    userId: string,
    credentials: UserCredentials,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<void> {
    const blob = await this.encrypt(credentials, userId);

    await this.dbClient.putUserCredentials({
      user_id: userId,
      agent_id: agentId,
      credentials_blob: blob,
      kms_key_id: this.kmsKeyId,
      updated_at: new Date().toISOString(),
    });

    const cacheKey = `${userId}:${agentId}`;
    this.cache.set(cacheKey, { credentials, cachedAt: Date.now() });
  }

  /**
   * Delete credentials for a user+agent.
   * [claude-infra] Multi-instance: deletes specific agent's credentials.
   */
  async deleteCredentials(userId: string, agentId: string = DEFAULT_AGENT_ID): Promise<void> {
    await this.dbClient.deleteUserCredentials(userId, agentId);
    this.cache.delete(`${userId}:${agentId}`);
  }

  /**
   * Invalidate the cached credentials for a user+agent.
   */
  invalidateCache(userId: string, agentId: string = DEFAULT_AGENT_ID): void {
    this.cache.delete(`${userId}:${agentId}`);
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Encrypt a UserCredentials object using KMS.
   * Returns base64-encoded ciphertext.
   */
  private async encrypt(credentials: UserCredentials, userId: string): Promise<string> {
    const { EncryptCommand } = await import("@aws-sdk/client-kms");
    const plaintext = new TextEncoder().encode(JSON.stringify(credentials));

    const result = await this.kmsClient.send(
      new EncryptCommand({
        KeyId: this.kmsKeyId,
        Plaintext: plaintext,
        EncryptionContext: { user_id: userId },
      }),
    );

    const ciphertextBlob = (result as { CiphertextBlob?: Uint8Array }).CiphertextBlob;
    if (!ciphertextBlob) {
      throw new Error(`KMS encryption failed for user ${userId}`);
    }

    return uint8ArrayToBase64(ciphertextBlob);
  }

  /**
   * Decrypt a base64-encoded ciphertext blob back to UserCredentials.
   * The encryption context must match what was used during encryption.
   */
  private async decrypt(blob: string, userId: string): Promise<UserCredentials> {
    const { DecryptCommand } = await import("@aws-sdk/client-kms");
    const ciphertext = base64ToUint8Array(blob);

    const result = await this.kmsClient.send(
      new DecryptCommand({
        CiphertextBlob: ciphertext,
        EncryptionContext: { user_id: userId },
      }),
    );

    const plaintext = (result as { Plaintext?: Uint8Array }).Plaintext;
    if (!plaintext) {
      throw new Error(`KMS decryption failed for user ${userId}`);
    }

    return JSON.parse(new TextDecoder().decode(plaintext)) as UserCredentials;
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
