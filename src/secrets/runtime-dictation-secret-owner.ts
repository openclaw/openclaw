/** Stable runtime SecretRef owner id for one configured dictation provider entry. */
export function runtimeDictationSecretOwnerId(providerConfigId: string): string {
  return `dictation:${providerConfigId}`;
}
