import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logError, logInfo } from "../logger.js";

const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");
const masterKey = Buffer.from(MASTER_KEY, "hex");

export interface EncryptedData {
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

export function encryptSecret(plaintext: string): EncryptedData {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from("openclaw-credential"));
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted,
  };
}

export function decryptSecret(encryptedData: EncryptedData): string {
  const iv = Buffer.from(encryptedData.iv, "base64");
  const tag = Buffer.from(encryptedData.tag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAAD(Buffer.from("openclaw-credential"));
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedData.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export async function encryptAndSave(filePath: string, data: unknown): Promise<void> {
  const plaintext = JSON.stringify(data);
  const encrypted = encryptSecret(plaintext);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(encrypted), "utf8");
}

export async function loadAndDecrypt(filePath: string): Promise<unknown> {
  const fileContent = await fs.readFile(filePath, "utf8");
  const encryptedData: EncryptedData = JSON.parse(fileContent);
  const plaintext = decryptSecret(encryptedData);
  return JSON.parse(plaintext);
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString("hex");
}
