// Owner device key D for this browser origin: a non-extractable Ed25519 key
// kept in IndexedDB (structured clone keeps it non-extractable), one per claw.
import type { StatementSigner } from "../../../../packages/openclaw-id-protocol/src/index.ts";
import { requestResult } from "../chat/control-ui-database.runtime.ts";
import { listen } from "../reactive/listener.ts";

const DB_NAME = "openclaw-id";
const STORE = "owner-devices";
const keyListeners = new Set<() => void>();

/** Notifies approval lifetimes after a newly linked browser has durably stored D. */
export function subscribeOwnerDeviceKey(listener: () => void) {
  keyListeners.add(listener);
  return () => {
    keyListeners.delete(listener);
  };
}

type StoredDeviceKey = { privateKey: CryptoKey; publicKey: CryptoKey };

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, 1);
  listen(request, "upgradeneeded", () => request.result.createObjectStore(STORE), { once: true });
  return requestResult(request);
}

// Runs one request in its own transaction.
async function run<T>(mode: IDBTransactionMode, operate: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDatabase();
  try {
    return await requestResult(operate(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

async function toSigner(pair: StoredDeviceKey): Promise<StatementSigner> {
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey,
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array(message))),
  };
}

/** Creates a new non-extractable device key (not stored until `saveOwnerDeviceKey`). */
export async function generateOwnerDeviceKey(): Promise<{
  pair: StoredDeviceKey;
  signer: StatementSigner;
}> {
  const generated = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  // SAFETY: generateKey for an Ed25519 algorithm returns a CryptoKeyPair.
  const pair = generated as StoredDeviceKey;
  return { pair, signer: await toSigner(pair) };
}

/** This origin's owner device signer for a claw, or undefined when it holds none. */
export async function loadOwnerDeviceSigner(clawId: string): Promise<StatementSigner | undefined> {
  const pair = await run<StoredDeviceKey | undefined>("readonly", (store) => store.get(clawId));
  return pair ? await toSigner(pair) : undefined;
}

/** A mailbox-only peer proof key. It is never enrolled in the claw or granted tunnel access. */
export async function loadMailboxPeerSigner(clawId: string): Promise<StatementSigner> {
  const key = `${clawId}:mailbox`;
  const stored = await run<StoredDeviceKey | undefined>("readonly", (store) => store.get(key));
  if (stored) {
    return toSigner(stored);
  }
  const generated = await generateOwnerDeviceKey();
  try {
    // Two tabs may start together; retain the first key instead of replacing a bound W.
    await run("readwrite", (store) => store.add(generated.pair, key));
    return generated.signer;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "ConstraintError") {
      throw error;
    }
    const existing = await run<StoredDeviceKey>("readonly", (store) => store.get(key));
    return toSigner(existing);
  }
}

/** Stores this origin's owner device key for a claw. */
export async function saveOwnerDeviceKey(clawId: string, pair: StoredDeviceKey): Promise<void> {
  await run("readwrite", (store) => store.put(pair, clawId));
  keyListeners.forEach((listener) => listener());
}
