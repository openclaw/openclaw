import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecretRef } from "../config/types.secrets.js";
import { startSecretEgressProxyWorker } from "./egress-proxy/proxy-worker.js";
import { sealSecretSentinel } from "./sentinel.js";
import { assertSecretStoreValue } from "./store/secret-store-validation.js";
import { readSelectedSecretStoreEntries } from "./store/secret-store.js";

export type JobSecretEgress = {
  /** Only opaque sentinels; safe to pass to the remote job. */
  remoteEnv: Readonly<Record<string, string>>;
  /** Authenticated upstream proxy environment, for the credential-owning host only. */
  hostEnv: Readonly<Record<string, string>>;
  /** Public trust bundle contents, suitable for a remote CA file. */
  caBundle: string;
  /** Synchronously fences access before process termination or bridge cleanup. */
  revoke: () => void;
};

type JobSecret = { envName: string; name: string; value: string; allowedHosts: readonly string[] };

function assertJobEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error("Setup egress environment names must be valid POSIX names");
  }
}

/** One owner for standalone jobs' proxy, grants, cancellation, and CA cleanup. */
export async function withJobSecretEgress<T>(
  params: { secrets: readonly JobSecret[]; signal?: AbortSignal; allowedHosts?: readonly string[] },
  run: (egress: JobSecretEgress) => Promise<T>,
): Promise<T> {
  params.signal?.throwIfAborted();
  const remoteEnv: Record<string, string> = Object.create(null);
  const bindings = params.secrets.map((secret) => {
    assertJobEnvName(secret.envName);
    assertSecretStoreValue(secret.value, "secret", secret.name);
    const sentinel = sealSecretSentinel(secret.value, { label: `job-egress:${secret.name}` });
    remoteEnv[secret.envName] = sentinel;
    return { name: secret.name, sentinel, allowedHosts: secret.allowedHosts };
  });
  await using resources = new AsyncDisposableStack();
  const caDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-job-egress-"));
  resources.defer(() => fs.rm(caDir, { recursive: true, force: true }));
  params.signal?.throwIfAborted();
  const proxy = await startSecretEgressProxyWorker({
    caDir,
    allowedHosts: params.allowedHosts,
    onAudit: () => {},
  });
  resources.defer(() => proxy.stop());
  params.signal?.throwIfAborted();
  const grant = await proxy.registerProcess(bindings);
  resources.defer(() => {
    grant.revoke();
    params.signal?.removeEventListener("abort", grant.revoke);
  });
  params.signal?.addEventListener("abort", grant.revoke, { once: true });
  params.signal?.throwIfAborted();
  const caBundle = await fs.readFile(grant.env.NODE_EXTRA_CA_CERTS!, "utf8");
  params.signal?.throwIfAborted();
  const result = await run({ remoteEnv, hostEnv: grant.env, caBundle, revoke: grant.revoke });
  params.signal?.throwIfAborted();
  return result;
}

export type SetupSecretEgressOptions = {
  /** Explicit environment-name to shared-store SecretRef selection. */
  secrets: Readonly<Record<string, SecretRef>>;
  /** Job owner closes this authority before terminating its process. */
  signal: AbortSignal;
};

async function readSetupSecrets(params: SetupSecretEgressOptions): Promise<JobSecret[]> {
  params.signal.throwIfAborted();
  const selection = Object.entries(params.secrets).map(([envName, ref]) => {
    assertJobEnvName(envName);
    if (ref.source !== "store") {
      throw new Error("Setup egress requires shared-store SecretRefs");
    }
    return { envName, name: ref.id };
  });
  const entries = await readSelectedSecretStoreEntries({
    names: selection.map((secret) => secret.name),
    assertCurrent: () => params.signal.throwIfAborted(),
  });
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  params.signal.throwIfAborted();
  return selection.map(({ envName, name }) => {
    const entry = byName.get(name);
    if (!entry) {
      throw new Error(
        `Setup egress secret "${name}" was not found as a protected shared-store entry`,
      );
    }
    if (!entry.allowedHosts.length) {
      throw new Error(
        `Setup secret "${name}" has no destination bindings; run openclaw secrets store set ${name} --allow-host <host> before retrying`,
      );
    }
    return { envName, name: entry.name, value: entry.value, allowedHosts: entry.allowedHosts };
  });
}

/** Validate required inputs before allocation without opening a proxy or granting access. */
export async function validateSetupSecretEgress(params: SetupSecretEgressOptions): Promise<void> {
  await readSetupSecrets(params);
}

/** Reread selected protected rows at grant creation; preparation never retains credential values. */
export async function withSetupSecretEgress<T>(
  params: SetupSecretEgressOptions,
  run: (egress: JobSecretEgress) => Promise<T>,
): Promise<T> {
  return withJobSecretEgress(
    { secrets: await readSetupSecrets(params), signal: params.signal },
    run,
  );
}
