// Ownership records for updater-created dev checkouts, held in the shared state database.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createCorePluginStateSyncKeyedStore } from "../../plugin-state/plugin-state-store.js";

const MANAGED_CHECKOUT_OWNER_ID = "core:update-cli" as const;
const MANAGED_CHECKOUT_NAMESPACE = "managed-checkouts";
const MANAGED_CHECKOUT_MAX_ENTRIES = 64;

const MANAGED_CHECKOUT_MARKER = ".openclaw-update-managed";

type ManagedCheckoutRecord = {
  token: string;
  dir: string;
  createdAtMs: number;
};

function openManagedCheckoutStore(env?: NodeJS.ProcessEnv) {
  return createCorePluginStateSyncKeyedStore<ManagedCheckoutRecord>({
    ownerId: MANAGED_CHECKOUT_OWNER_ID,
    namespace: MANAGED_CHECKOUT_NAMESPACE,
    maxEntries: MANAGED_CHECKOUT_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
    ...(env ? { env } : {}),
  });
}

function managedCheckoutKey(dir: string): string {
  return createHash("sha256").update(path.resolve(dir)).digest("hex");
}

function managedCheckoutMarkerPath(dir: string): string {
  return path.join(dir, ".git", MANAGED_CHECKOUT_MARKER);
}

function readManagedCheckoutToken(dir: string, env?: NodeJS.ProcessEnv): string | null {
  const record = openManagedCheckoutStore(env).lookup(managedCheckoutKey(dir));
  const token = record?.token?.trim();
  return token ? token : null;
}

async function readMarkerToken(dir: string): Promise<string | null> {
  return await fs
    .readFile(managedCheckoutMarkerPath(dir), "utf8")
    .then((value) => value.trim() || null)
    .catch(() => null);
}

/** Claim `dir` as an updater-owned conversion target and return the ownership token. */
export function claimManagedGitCheckout(dir: string, env?: NodeJS.ProcessEnv): string {
  const token = randomUUID();
  openManagedCheckoutStore(env).register(managedCheckoutKey(dir), {
    token,
    dir: path.resolve(dir),
    createdAtMs: Date.now(),
  });
  return token;
}

/** Write the in-checkout half of the ownership pair before the checkout is swapped in. */
export async function writeManagedCheckoutMarker(dir: string, token: string): Promise<void> {
  await fs.mkdir(path.dirname(managedCheckoutMarkerPath(dir)), { recursive: true });
  await fs.writeFile(managedCheckoutMarkerPath(dir), `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Resolve the ownership token when `dir` is a checkout this updater created and left behind. */
export async function resolveManagedGitCheckoutToken(
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const recordToken = readManagedCheckoutToken(dir, env);
  if (!recordToken) {
    return null;
  }
  return recordToken === (await readMarkerToken(dir)) ? recordToken : null;
}

/** Report whether `dir` is a checkout this updater created and left behind. */
export async function isManagedGitCheckoutRetry(
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  return (await resolveManagedGitCheckoutToken(dir, env)) !== null;
}

/** Report whether `dir` is an empty destination this updater reserved but never filled. */
export async function isReclaimableManagedReservation(
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!readManagedCheckoutToken(dir, env)) {
    return false;
  }
  const entries = await fs.readdir(dir).catch(() => null);
  return entries?.length === 0;
}

/** Report whether an existing `dir` is one a package-to-dev conversion may still take over. */
export async function isReusableManagedGitCheckoutPath(
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  return (
    (await isManagedGitCheckoutRetry(dir, env)) || (await isReclaimableManagedReservation(dir, env))
  );
}

/** Retire the ownership pair once the conversion has succeeded or its checkout is gone. */
export async function completeManagedGitCheckout(
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  openManagedCheckoutStore(env).delete(managedCheckoutKey(dir));
  await fs.rm(managedCheckoutMarkerPath(dir), { force: true });
}
