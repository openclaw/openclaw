import type { MockGatewayControls, MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";

export function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.patch params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

export async function resolveConfigMutation(
  gateway: MockGatewayControls,
  config: Record<string, unknown>,
  hash: string,
  apiKeyProvider?: string,
) {
  await gateway.setMethodResponse("config.get", {
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  });
  await gateway.resolveDeferred(
    apiKeyProvider ? "models.authSetApiKey" : "config.patch",
    apiKeyProvider
      ? { provider: apiKeyProvider, profileId: `${apiKeyProvider}:manual-api-key` }
      : { ok: true, config, hash },
  );
}
