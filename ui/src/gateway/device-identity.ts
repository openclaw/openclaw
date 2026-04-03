import * as ed from "@noble/ed25519";
import type { DeviceIdentity } from "./types";

const STORAGE_KEY = "openclaw-device-identity-v1";

interface StoredIdentity {
  id: string;
  publicKey: string;
  privateKey: string;
}

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed: StoredIdentity = JSON.parse(stored);
    const privateKeyBytes = hexToBytes(parsed.privateKey);
    return {
      id: parsed.id,
      publicKey: parsed.publicKey,
      sign: (data: Uint8Array) => ed.signAsync(data, privateKeyBytes),
    };
  }

  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const id = generateId();

  const identity: StoredIdentity = {
    id,
    publicKey: bytesToHex(publicKey),
    privateKey: bytesToHex(privateKey),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));

  return {
    id,
    publicKey: identity.publicKey,
    sign: (data: Uint8Array) => ed.signAsync(data, privateKey),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
