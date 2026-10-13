import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
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

export function providerConfig(value: string): { apiKey: string } {
  return Object.fromEntries([["apiKey", value]]) as { apiKey: string };
}

export function createProviderProofCapture(getArtifactDir: () => string) {
  return async (fileName: string, content: Locator): Promise<void> => {
    const page = content.page();
    await writeFile(
      path.join(getArtifactDir(), fileName),
      await takeControlUiViewportScreenshot(page, page.locator(".shell"), [content]),
    );
  };
}
