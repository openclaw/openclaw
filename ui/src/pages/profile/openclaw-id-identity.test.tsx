/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { OpenClawIdIdentity } from "./openclaw-id-identity.tsx";
import { createConnectedContext } from "./profile-page.test-support.tsx";

let stopFeature: () => void;
beforeEach(() => {
  stopFeature = startOpenClawIdFeatureLifetime();
});
afterEach(() => {
  stopFeature();
  cleanupSolid();
});

function status(accountSignIn: "popup" | "device" | null, state = "on") {
  return {
    status: { state },
    link: { linked: true, hostname: "studio-e61zr.crabd.xyz" },
    channel: null,
    accountSignIn,
    services: { issuerUrl: null, discoveryUrl: null, loaderDomain: null },
  };
}

function mount(request: GatewayBrowserClient["request"]) {
  const { context } = createConnectedContext(request);
  return mountSolid(() => <OpenClawIdIdentity />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
}

it("shows the linked account with its claw role and unlinks it", async () => {
  let linked: { email: string; owner: boolean } | null = { email: "josh@id.test", owner: true };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "openclawId.status") {
      return status("device");
    }
    if (params?.action === "unlink") {
      linked = null;
      return { unlinked: true };
    }
    return { linked };
  }) as unknown as GatewayBrowserClient["request"];
  const view = mount(request);
  await waitForSolid(() =>
    expect(view.container.textContent).toContain("josh@id.test · Owner of studio"),
  );
  view.getByText("Unlink").click();
  await waitForSolid(() => expect(view.container.textContent).toContain("Not linked"));
  expect(request).toHaveBeenCalledWith("openclawId.account", { action: "unlink" });
  expect(view.getByText("Link")).toBeDefined();
});

it.each([
  ["the claw's own computer (popup sign-in)", status("popup")],
  ["a connection without a personal sign-in", status(null)],
  ["the Labs switch off", status("device", "off")],
])("is absent on %s", async (_name, current) => {
  const request = vi.fn(async (method: string) =>
    method === "openclawId.status" ? current : { linked: null },
  ) as unknown as GatewayBrowserClient["request"];
  const view = mount(request);
  await waitForSolid(() => expect(request).toHaveBeenCalledWith("openclawId.status", {}));
  await Promise.resolve();
  expect(view.container.textContent).not.toContain("OpenClaw ID");
  expect(request).not.toHaveBeenCalledWith("openclawId.account", expect.anything());
});
