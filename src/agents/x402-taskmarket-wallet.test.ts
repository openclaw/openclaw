import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  __testing,
  clearTaskmarketAccountCache,
  createTaskmarketAccount,
  parseTaskmarketWalletConfig,
  TaskmarketWalletError,
} from "./x402-taskmarket-wallet.js";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createTaskmarketSentinel(payload: {
  v: number;
  keystorePath: string;
  apiUrl?: string;
}): string {
  return `taskmarket:${encodeBase64Url(JSON.stringify(payload))}`;
}

function encryptTaskmarketPrivateKey(params: { privateKey: string; dekHex: string }): string {
  const key = Buffer.from(params.dekHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(params.privateKey, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("hex");
}

describe("parseTaskmarketWalletConfig", () => {
  it("parses a valid taskmarket sentinel", () => {
    const sentinel = createTaskmarketSentinel({
      v: 1,
      keystorePath: "~/.taskmarket/keystore.json",
      apiUrl: "https://api-market.daydreams.systems",
    });
    expect(parseTaskmarketWalletConfig(sentinel)).toEqual({
      v: 1,
      keystorePath: "~/.taskmarket/keystore.json",
      apiUrl: "https://api-market.daydreams.systems",
    });
  });

  it("returns null for non-taskmarket values", () => {
    expect(parseTaskmarketWalletConfig("0xabc")).toBeNull();
    expect(parseTaskmarketWalletConfig("saw:main@/tmp/saw.sock")).toBeNull();
    expect(parseTaskmarketWalletConfig(undefined)).toBeNull();
  });

  it("defaults the api url when omitted", () => {
    const sentinel = createTaskmarketSentinel({
      v: 1,
      keystorePath: "~/.taskmarket/keystore.json",
    });
    expect(parseTaskmarketWalletConfig(sentinel)).toEqual({
      v: 1,
      keystorePath: "~/.taskmarket/keystore.json",
      apiUrl: process.env.TASKMARKET_API_URL || "https://api-market.daydreams.systems",
    });
  });

  it("throws for malformed taskmarket payload", () => {
    expect(() => parseTaskmarketWalletConfig("taskmarket:not-base64")).toThrow(
      TaskmarketWalletError,
    );
  });
});

describe("decryptTaskmarketPrivateKey", () => {
  it("decrypts taskmarket AES-256-GCM payloads", () => {
    const privateKey = `0x${randomBytes(32).toString("hex")}`;
    const dekHex = randomBytes(32).toString("hex");
    const encrypted = encryptTaskmarketPrivateKey({ privateKey, dekHex });
    const decrypted = __testing.decryptTaskmarketPrivateKey(dekHex, encrypted);
    expect(decrypted).toBe(privateKey);
  });

  it("throws when ciphertext is tampered", () => {
    const privateKey = `0x${randomBytes(32).toString("hex")}`;
    const dekHex = randomBytes(32).toString("hex");
    const encrypted = encryptTaskmarketPrivateKey({ privateKey, dekHex });
    const tampered = `${encrypted.slice(0, -2)}00`;
    expect(() => __testing.decryptTaskmarketPrivateKey(dekHex, tampered)).toThrow(
      TaskmarketWalletError,
    );
  });
});

describe("createTaskmarketAccount cache", () => {
  it("reuses cached account within ttl", async () => {
    clearTaskmarketAccountCache();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-taskmarket-wallet-"));
    try {
      const privateKey = `0x${randomBytes(32).toString("hex")}`;
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const dekHex = randomBytes(32).toString("hex");
      const encryptedKey = encryptTaskmarketPrivateKey({ privateKey, dekHex });
      const keystorePath = path.join(tempDir, "keystore.json");
      await fs.writeFile(
        keystorePath,
        JSON.stringify({
          encryptedKey,
          walletAddress: account.address,
          deviceId: "device-1",
          apiToken: "token-1",
        }),
        "utf8",
      );

      let calls = 0;
      const fetchFn: typeof fetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ deviceEncryptionKey: dekHex }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const config = { v: 1 as const, keystorePath, apiUrl: "https://api.example.test" };
      const first = await createTaskmarketAccount({
        config,
        fetchFn,
        nowMs: () => 1_000,
        ttlMs: 60_000,
      });
      const second = await createTaskmarketAccount({
        config,
        fetchFn,
        nowMs: () => 30_000,
        ttlMs: 60_000,
      });

      expect(first.ownerAddress).toBe(account.address);
      expect(second.ownerAddress).toBe(account.address);
      expect(calls).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      clearTaskmarketAccountCache();
    }
  });

  it("retries once after a transient device-key error", async () => {
    clearTaskmarketAccountCache();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-taskmarket-wallet-"));
    try {
      const privateKey = `0x${randomBytes(32).toString("hex")}`;
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const dekHex = randomBytes(32).toString("hex");
      const encryptedKey = encryptTaskmarketPrivateKey({ privateKey, dekHex });
      const keystorePath = path.join(tempDir, "keystore.json");
      await fs.writeFile(
        keystorePath,
        JSON.stringify({
          encryptedKey,
          walletAddress: account.address,
          deviceId: "device-1",
          apiToken: "token-1",
        }),
        "utf8",
      );

      let calls = 0;
      const fetchFn: typeof fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("temporary outage", { status: 500 });
        }
        return new Response(JSON.stringify({ deviceEncryptionKey: dekHex }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const resolved = await createTaskmarketAccount({
        config: { v: 1, keystorePath, apiUrl: "https://api.example.test" },
        fetchFn,
      });

      expect(resolved.ownerAddress).toBe(account.address);
      expect(calls).toBe(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      clearTaskmarketAccountCache();
    }
  });
});
