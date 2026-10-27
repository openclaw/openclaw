import { fireEvent } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { expect, it } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { createChangeListeners } from "../../../../src/shared/listeners.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import {
  createApplicationGatewaySnapshot,
  createApplicationGateway,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SecretsPage } from "./secrets-page.tsx";

registerSettingsEnglish();

const entry = (name: string): SecretStoreEntry => ({
  name,
  kind: "env",
  value: "https://service.example.test",
  scopeKind: "team",
  scopeId: "",
  createdAtMs: 1,
  updatedAtMs: 2,
});

function mountPage(request: ReturnType<typeof createGatewayRequestMock>) {
  const snapshot = createApplicationGatewaySnapshot({
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: gatewayHelloForMethods(["secrets.store.list", "secrets.store.set"]),
  });
  const source = createApplicationGateway(snapshot);
  let pathname = "/settings/secrets";
  const route = createChangeListeners();
  // SAFETY: Secrets consumes the Gateway and pathname subscription from this fixture.
  const context = {
    gateway: source.gateway,
    router: {
      getState: () => ({ location: { pathname } }),
      subscribe: route.subscribe,
    },
  } as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  let hide = () => {};
  const page = mountSolid(
    () => {
      const [visible, setVisible] = createSignal(true);
      hide = () => setVisible(false);
      return (
        <Show when={visible()}>
          <SecretsPage />
        </Show>
      );
    },
    { wrapper: provider.wrapper },
  );
  flush();
  const query = (selector: string) => page.container.querySelector<HTMLElement>(selector)!;
  const dialog = () => query("openclaw-modal-dialog");
  const submit = () =>
    page.container.querySelector<HTMLButtonElement>('.secrets-store-dialog button[type="submit"]')!;
  const openDraft = async () => {
    query("button.primary").click();
    await waitForSolid(() => expect(dialog()).not.toBeNull());
    const field = page.container.querySelector<HTMLInputElement>('input[name="name"]')!;
    fireEvent.input(field, { target: { value: "api_token" } });
    fireEvent.input(query('textarea[name="value"]'), { target: { value: "https://example.test" } });
    flush();
  };
  return {
    page,
    source,
    snapshot,
    query,
    dialog,
    submit,
    openDraft,
    waitText: (text: string) =>
      waitForSolid(() => expect(page.container.textContent).toContain(text)),
    leaveRoute: () => {
      pathname = "/settings/profile";
      route.publish();
      hide();
    },
  };
}

it.each(["reconnect", "route"])("retires connection-scoped reads and saves on %s", async (exit) => {
  const stale = createDeferred<{ entries: SecretStoreEntry[] }>();
  const previousRequest = createGatewayRequestMock(async () => stale.promise);
  const { page, source, snapshot, query, dialog, submit, openDraft, waitText, leaveRoute } =
    mountPage(previousRequest);
  const firstSave = createDeferred<unknown>();
  const secondSave = createDeferred<unknown>();
  let saveCount = 0;
  source.publish({ ...snapshot, phase: "reconnecting" });
  flush();
  const currentRequest = createGatewayRequestMock(async (method) => {
    if (method === "secrets.store.list") {
      return { entries: [entry("CURRENT_URL")] };
    }
    if (method === "secrets.store.set") {
      return ++saveCount === 1 ? firstSave.promise : secondSave.promise;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  source.publish({ ...snapshot, client: createTestGatewayClient(currentRequest) });
  await waitText("CURRENT_URL");
  stale.resolve({ entries: [entry("STALE_URL")] });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  flush();
  expect(page.container.textContent).toContain("CURRENT_URL");
  expect(page.container.textContent).not.toContain("STALE_URL");

  await openDraft();
  expect(page.container.querySelector<HTMLInputElement>('input[value="secret"]')!.checked).toBe(
    true,
  );
  submit().click();
  await waitForSolid(() => expect(submit().textContent).toContain("Saving"));
  expect(submit().disabled).toBe(true);
  firstSave.reject(new Error("Synthetic save unavailable"));
  await waitForSolid(() => expect(submit().disabled).toBe(false));
  expect(page.container.textContent).toContain("Synthetic save unavailable");
  expect(page.container.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe(
    "API_TOKEN",
  );
  submit().click();
  await waitForSolid(() => expect(submit().disabled).toBe(true));
  expect(saveCount).toBe(2);
  if (exit === "reconnect") {
    const replacement = createGatewayRequestMock(async () => ({
      entries: [entry("REPLACEMENT_URL")],
    }));
    source.publish({ ...snapshot, client: createTestGatewayClient(replacement) });
    await waitText("REPLACEMENT_URL");
    expect(dialog()).toBeNull();
  } else {
    leaveRoute();
    await waitForSolid(() => expect(query("openclaw-secrets-page")).toBeNull());
  }
  secondSave.reject(new Error("Retired save unavailable"));
  await Promise.resolve();
  flush();
  expect(page.container.textContent).not.toContain("Retired save unavailable");
  page.unmount();
  const retiredRequest = createGatewayRequestMock(async () => ({ entries: [] }));
  source.publish({ ...snapshot, client: createTestGatewayClient(retiredRequest) });
  flush();
  expect(retiredRequest).not.toHaveBeenCalled();
});
