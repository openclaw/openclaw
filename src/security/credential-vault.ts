import crypto from "node:crypto";
import type { KeyProvider } from "./key-management.js";

export interface EncryptedData {
  version: number;
  encryption: {
    algorithm: string;
    iv: string;
    authTag: string;
  };
  data: string;
}

export class CredentialVault {
  constructor(private keyProvider: KeyProvider) {}

  async encrypt(data: unknown): Promise<EncryptedData> {
    const algorithm = "aes-256-gcm";
    const key = await this.keyProvider.getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    const jsonData = JSON.stringify(data);
    let encrypted = cipher.update(jsonData, "utf8", "base64");
    encrypted += cipher.final("base64");

    const authTag = (cipher as crypto.CipherGCM).getAuthTag();

    return {
      version: 2,
      encryption: {
        algorithm,
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
      },
      data: encrypted,
    };
  }

  async decrypt(encryptedData: EncryptedData): Promise<unknown> {
    if (encryptedData.version !== 2) {
      throw new Error(`Unsupported encryption version: ${encryptedData.version}`);
    }

    const { algorithm, iv, authTag } = encryptedData.encryption;
    if (!authTag) {
      throw new Error("Missing authentication tag - data may be corrupted");
    }

    const key = await this.keyProvider.getKey();
    const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(iv, "base64"));
    (decipher as crypto.DecipherGCM).setAuthTag(Buffer.from(authTag, "base64"));

    let decrypted = decipher.update(encryptedData.data, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted);
  }

  async isEncrypted(data: unknown): Promise<boolean> {
    const obj = data as any;
    return Boolean(
      obj?.version === 2 &&
      obj?.encryption?.algorithm &&
      obj?.encryption?.iv &&
      obj?.encryption?.authTag &&
      typeof obj?.data === "string",
    );
  }
}
