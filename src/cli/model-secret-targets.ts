// Keep model credential targets independent of channel and web capability discovery.
export const MODEL_COMMAND_SECRET_TARGET_IDS = [
  "models.providers.*.apiKey",
  "models.providers.*.headers.*",
  "models.providers.*.request.headers.*",
  "models.providers.*.request.auth.token",
  "models.providers.*.request.auth.value",
  "models.providers.*.request.proxy.tls.ca",
  "models.providers.*.request.proxy.tls.cert",
  "models.providers.*.request.proxy.tls.key",
  "models.providers.*.request.proxy.tls.passphrase",
  "models.providers.*.request.tls.ca",
  "models.providers.*.request.tls.cert",
  "models.providers.*.request.tls.key",
  "models.providers.*.request.tls.passphrase",
] as const;

/** Model-provider credential targets used by commands that can touch provider config. */
export function getModelsCommandSecretTargetIds(): Set<string> {
  return new Set(MODEL_COMMAND_SECRET_TARGET_IDS);
}
