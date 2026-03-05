import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "../infra/file-lock.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../plugin-sdk/json-store.js";

export type TrustedPeer = {
  deviceId: string;
  displayName?: string;
  publicKey?: string;
  addedAt: string;
};

type TrustedPeersStore = {
  version: 1;
  peers: TrustedPeer[];
};

const STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

const EMPTY_STORE: TrustedPeersStore = { version: 1, peers: [] };

function resolveStorePath(): string {
  return path.join(resolveStateDir(), "mesh", "trusted-peers.json");
}

async function ensureFile(filePath: string) {
  try {
    await fs.promises.access(filePath);
  } catch {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await writeJsonFileAtomically(filePath, EMPTY_STORE);
  }
}

async function withStore<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const filePath = resolveStorePath();
  await ensureFile(filePath);
  return await withFileLock(filePath, STORE_LOCK_OPTIONS, async () => {
    return await fn(filePath);
  });
}

async function readStore(filePath: string): Promise<TrustedPeer[]> {
  const { value } = await readJsonFileWithFallback<TrustedPeersStore>(filePath, EMPTY_STORE);
  return Array.isArray(value.peers) ? value.peers : [];
}

async function writeStore(filePath: string, peers: TrustedPeer[]): Promise<void> {
  await writeJsonFileAtomically(filePath, { version: 1, peers } satisfies TrustedPeersStore);
}

export async function listTrustedPeers(): Promise<TrustedPeer[]> {
  return await withStore(async (filePath) => {
    return await readStore(filePath);
  });
}

export async function addTrustedPeer(params: {
  deviceId: string;
  displayName?: string;
  publicKey?: string;
}): Promise<{ added: boolean }> {
  return await withStore(async (filePath) => {
    const peers = await readStore(filePath);
    if (peers.some((p) => p.deviceId === params.deviceId)) {
      return { added: false };
    }
    const entry: TrustedPeer = {
      deviceId: params.deviceId,
      displayName: params.displayName,
      publicKey: params.publicKey,
      addedAt: new Date().toISOString(),
    };
    await writeStore(filePath, [...peers, entry]);
    return { added: true };
  });
}

export async function removeTrustedPeer(deviceId: string): Promise<{ removed: boolean }> {
  return await withStore(async (filePath) => {
    const peers = await readStore(filePath);
    const next = peers.filter((p) => p.deviceId !== deviceId);
    if (next.length === peers.length) {
      return { removed: false };
    }
    await writeStore(filePath, next);
    return { removed: true };
  });
}

export async function isTrustedPeer(deviceId: string): Promise<boolean> {
  return await withStore(async (filePath) => {
    const peers = await readStore(filePath);
    return peers.some((p) => p.deviceId === deviceId);
  });
}

export async function getTrustedPeer(deviceId: string): Promise<TrustedPeer | null> {
  return await withStore(async (filePath) => {
    const peers = await readStore(filePath);
    return peers.find((p) => p.deviceId === deviceId) ?? null;
  });
}
