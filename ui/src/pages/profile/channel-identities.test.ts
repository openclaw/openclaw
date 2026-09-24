/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { ChannelIdentities } from "./channel-identities.ts";
import { createConnectedContext, modelAccountProfile } from "./profile-page.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount(
  scopes: string[] = ["operator.admin"],
  request = vi.fn(async () => ({ profiles: [modelAccountProfile] })),
) {
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  harness.emitHello(gatewayHelloForMethods([], scopes));
  const provider = createApplicationContextProvider(harness.context);
  const section = new ChannelIdentities();
  provider.append(section);
  document.body.append(provider);
  return { ...harness, section, request };
}

it.each([{ scopes: [] }, { scopes: ["operator.read"] }, { scopes: ["operator.write"] }])(
  "keeps administrative identity linking unavailable with $scopes",
  async ({ scopes }) => {
    const { section, request } = mount(scopes);
    await section.updateComplete;
    expect(section.querySelector("button")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  },
);

it.each(["disconnect", "scope"])("discards a directory reply after %s", async (change) => {
  const pending = createDeferred<{ profiles: (typeof modelAccountProfile)[] }>();
  const request = vi.fn(() => pending.promise);
  const harness = mount(["operator.admin"], request);
  await harness.section.updateComplete;
  harness.section.querySelector<HTMLButtonElement>("button")!.click();
  await harness.section.updateComplete;
  expect(request).toHaveBeenCalledExactlyOnceWith("users.list", {});
  if (change === "disconnect") {
    harness.emitConnected(false);
  } else {
    harness.emitHello(gatewayHelloForMethods([], ["operator.read"]));
  }
  await harness.section.updateComplete;
  pending.resolve({ profiles: [modelAccountProfile] });
  await pending.promise;
  await harness.section.updateComplete;
  expect(harness.section.querySelector("select")).toBeNull();
  expect(harness.section.textContent?.trim()).toBe("");
});
