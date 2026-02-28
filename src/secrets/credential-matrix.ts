import { listSecretTargetRegistryEntries } from "./target-registry.js";

type CredentialMatrixEntry = {
  id: string;
  configFile: "openclaw.json" | "auth-profiles.json";
  path: string;
  refPath?: string;
  when?: { type: "api_key" | "token" };
  secretShape: "secret_input" | "sibling_ref";
  optIn: true;
  notes?: string;
};

export type SecretRefCredentialMatrixDocument = {
  version: 1;
  matrixId: "strictly-user-supplied-credentials";
  pathSyntax: 'Dot path with "*" for map keys and "[]" for arrays.';
  scope: "Credentials that are strictly user-supplied and not minted/rotated by OpenClaw runtime.";
  excludedMutableOrRuntimeManaged: string[];
  entries: CredentialMatrixEntry[];
};

const EXCLUDED_MUTABLE_OR_RUNTIME_MANAGED = [
  "commands.ownerDisplaySecret",
  "gateway.auth.token",
  "hooks.token",
  "hooks.gmail.pushToken",
  "hooks.mappings[].sessionKey",
  "auth-profiles.oauth.*",
  "discord.threadBindings.*.webhookToken",
  "whatsapp.creds.json",
];

export function buildSecretRefCredentialMatrix(): SecretRefCredentialMatrixDocument {
  const entries: CredentialMatrixEntry[] = listSecretTargetRegistryEntries()
    .map((entry) => ({
      id: entry.id,
      configFile: entry.configFile,
      path: entry.pathPattern,
      ...(entry.refPathPattern ? { refPath: entry.refPathPattern } : {}),
      ...(entry.authProfileType ? { when: { type: entry.authProfileType } } : {}),
      secretShape: entry.secretShape,
      optIn: true as const,
      ...(entry.id.startsWith("channels.googlechat.")
        ? { notes: "Google Chat compatibility exception: sibling ref field remains canonical." }
        : {}),
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

  return {
    version: 1,
    matrixId: "strictly-user-supplied-credentials",
    pathSyntax: 'Dot path with "*" for map keys and "[]" for arrays.',
    scope:
      "Credentials that are strictly user-supplied and not minted/rotated by OpenClaw runtime.",
    excludedMutableOrRuntimeManaged: [...EXCLUDED_MUTABLE_OR_RUNTIME_MANAGED],
    entries,
  };
}
