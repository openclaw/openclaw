import type { Page } from "playwright";
import { expect } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";

// Advanced setup owns these wizard scenarios; credential-only choices belong
// to the Models connection picker and must not consume their setup methods.
export function installSetupGateway(page: Page, options: Parameters<typeof installMockGateway>[1]) {
  return installMockGateway(page, {
    ...options,
    featureMethods: [
      "config.get",
      "config.patch",
      "models.authStatus",
      "models.list",
      ...(options?.featureMethods ?? []),
    ],
    methodResponses: {
      "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
      ...options?.methodResponses,
    },
  });
}

export async function openModelSetup(page: Page, baseUrl?: string) {
  // Preserve coverage of old bookmarks while subsequent visits use the actual
  // Models entry point without replacing the current document or connection.
  const response = baseUrl ? await page.goto(`${baseUrl}settings/model-setup`) : null;
  if (!baseUrl) {
    await page.locator("[data-models-connect]").click();
  }
  await page.locator("[data-models-login-discover]").click();
  await page.getByRole("heading", { name: "On this Gateway", exact: true }).waitFor();
  expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
  return response;
}
