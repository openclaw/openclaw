import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { SecretRef } from "../config/types.secrets.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";

export async function resolveAuthProfileStoreForServiceEnv(
  authStore: AuthProfileStore | undefined,
): Promise<AuthProfileStore | undefined> {
  if (authStore) {
    return authStore;
  }
  // Keep the daemon install cold path cheap when there is no auth store to read.
  const { hasAnyAuthProfileStoreSource } =
    await import("./daemon-install-auth-profiles-source.runtime.js");
  if (!hasAnyAuthProfileStoreSource()) {
    return undefined;
  }
  const { loadAuthProfileStoreForSecretsRuntime } =
    await import("./daemon-install-auth-profiles-store.runtime.js");
  return loadAuthProfileStoreForSecretsRuntime();
}

export function collectAuthProfileSecretRefs(authStore: AuthProfileStore | undefined): SecretRef[] {
  if (!authStore) {
    return [];
  }
  return Object.values(authStore.profiles).flatMap((credential) => {
    const ref =
      credential.type === "api_key"
        ? credential.keyRef
        : credential.type === "token"
          ? credential.tokenRef
          : undefined;
    return ref ? [ref] : [];
  });
}

export function collectAuthProfileServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  authStore?: AuthProfileStore;
  warn?: DaemonInstallWarnFn;
}): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const ref of collectAuthProfileSecretRefs(params.authStore)) {
    if (ref.source !== "env") {
      continue;
    }
    const key = normalizeEnvVarKey(ref.id, { portable: true });
    if (!key) {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      params.warn?.(
        `Auth profile env ref "${key}" blocked by host-env security policy`,
        "Auth profile",
      );
      continue;
    }
    const value = params.env[key]?.trim();
    if (!value) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}
