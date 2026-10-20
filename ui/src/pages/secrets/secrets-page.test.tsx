import { afterEach, expect, it } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SecretsPage } from "./secrets-page.tsx";

registerSettingsEnglish();
afterEach(cleanupSolid);

function entry(name: string): SecretStoreEntry {
  return {
    name,
    kind: "env",
    value: "https://service.example.test",
    scopeKind: "team",
    scopeId: "",
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

it("keeps reconnect reads current and releases the Gateway binding when the page unmounts", async () => {
  const stale = createDeferred<{ entries: SecretStoreEntry[] }>();
  const previousRequest = createGatewayRequestMock(async () => stale.promise);
  const snapshot: ApplicationGatewaySnapshot = {
    client: createTestGatewayClient(previousRequest),
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["secrets.store.list", "secrets.store.set"], events: [] },
    },
  };
  const source = createApplicationGateway(snapshot);
  // SAFETY: Secrets consumes only the Gateway capability from this application fixture.
  const context = { gateway: source.gateway } as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const page = mountSolid(() => <SecretsPage />, { wrapper: provider.wrapper });
  flush();
  expect(previousRequest).toHaveBeenCalledExactlyOnceWith("secrets.store.list", {});

  source.publish({ ...snapshot, phase: "reconnecting" });
  flush();
  const currentRequest = createGatewayRequestMock(async () => ({
    entries: [entry("CURRENT_URL")],
  }));
  source.publish({ ...snapshot, client: createTestGatewayClient(currentRequest) });
  await waitForSolid(() => expect(page.container.textContent).toContain("CURRENT_URL"));
  expect(currentRequest).toHaveBeenCalledExactlyOnceWith("secrets.store.list", {});
  stale.resolve({ entries: [entry("STALE_URL")] });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  flush();
  expect(page.container.textContent).toContain("CURRENT_URL");
  expect(page.container.textContent).not.toContain("STALE_URL");

  page.container.querySelector<HTMLButtonElement>("button.primary")!.click();
  await waitForSolid(() =>
    expect(page.container.querySelector("openclaw-modal-dialog")).not.toBeNull(),
  );
  const name = page.container.querySelector<HTMLInputElement>('input[name="name"]')!;
  name.value = "api_token";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await waitForSolid(() => expect(name.value).toBe("API_TOKEN"));
  expect(page.container.querySelector<HTMLInputElement>('input[value="secret"]')!.checked).toBe(
    true,
  );
  page.container
    .querySelector<HTMLButtonElement>('.secrets-store-dialog button[type="button"]')!
    .click();
  await waitForSolid(() =>
    expect(page.container.querySelector("openclaw-modal-dialog")).toBeNull(),
  );

  page.unmount();
  const retiredRequest = createGatewayRequestMock(async () => ({ entries: [] }));
  source.publish({ ...snapshot, client: createTestGatewayClient(retiredRequest) });
  flush();
  expect(retiredRequest).not.toHaveBeenCalled();
});
