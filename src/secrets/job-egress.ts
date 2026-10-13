import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecretRef } from "../config/types.secrets.js";
import { startSecretEgressProxyWorker } from "./egress-proxy/proxy-worker.js";
import { sealSecretSentinel } from "./sentinel.js";
import {
  assertSecretStoreEnvName,
  assertSecretStoreValue,
} from "./store/secret-store-validation.js";
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

/** One owner for standalone jobs' proxy, grants, cancellation, and CA cleanup. */
export async function withJobSecretEgress<T>(
  params: { secrets: readonly JobSecret[]; signal?: AbortSignal; allowedHosts?: readonly string[] },
  run: (egress: JobSecretEgress) => Promise<T>,
): Promise<T> {
  params.signal?.throwIfAborted();
  const remoteEnv: Record<string, string> = {};
  const bindings = params.secrets.map((secret) => {
    assertSecretStoreEnvName(secret.envName);
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

/** Reads only selected protected store rows and binds their destination policy to one job. */
export async function withSetupSecretEgress<T>(
  params: SetupSecretEgressOptions,
  run: (egress: JobSecretEgress) => Promise<T>,
): Promise<T> {
  params.signal.throwIfAborted();
  const selection = Object.entries(params.secrets).map(([envName, ref]) => {
    assertSecretStoreEnvName(envName);
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
  const secrets = selection.map(({ envName, name }) => {
    const entry = byName.get(name);
    if (!entry) {
      throw new Error(
        `Setup egress secret "${name}" was not found as a protected shared-store entry`,
      );
    }
    return { envName, name: entry.name, value: entry.value, allowedHosts: entry.allowedHosts };
  });
  return withJobSecretEgress({ secrets, signal: params.signal }, run);
}
