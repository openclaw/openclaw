/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createConnectedContext } from "../profile/profile-page.test-support.tsx";
import { OpenClawIdPage } from "./openclaw-id-page.tsx";

afterEach(cleanupSolid);

function mount(channel: "local_operator" | "tunnel", enabled = true) {
  const request = vi.fn(async (method: string) =>
    method === "openclawId.status"
      ? {
          status: { state: "on" },
          link: { linked: true, hostname: "studio-k7x2q.crabd.xyz" },
          channel,
          owner: true,
          accountSignIn: channel === "local_operator" ? "popup" : null,
          remoteAccessSetup: channel === "local_operator" ? "local" : null,
          services: { issuerUrl: null, discoveryUrl: null, loaderDomain: "crabd.xyz" },
        }
      : { link: { linked: true, publication: { state: "published" } } },
  ) as unknown as GatewayBrowserClient["request"];
  const { context } = createConnectedContext(request);
  Object.assign(context.config.current, { openclawIdEnabled: enabled });
  const view = mountSolid(() => <OpenClawIdPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  return { view, request };
}

it("offers Reset owner access on the computer that runs the claw", async () => {
  const { view } = mount("local_operator");
  await waitForSolid(() => expect(view.getByText("Reset…")).toBeDefined());
  expect(view.container.textContent).toContain("studio-k7x2q.crabd.xyz");
  expect(view.container.textContent).toContain("Published");
  expect(view.container.textContent).not.toContain(
    "Reset owner access is only available on the computer that runs this claw.",
  );
});

it("shows one line instead of the Reset button over the tunnel", async () => {
  const { view } = mount("tunnel");
  await waitForSolid(() =>
    expect(view.container.textContent).toContain(
      "Reset owner access is only available on the computer that runs this claw.",
    ),
  );
  expect(view.queryByText("Reset…")).toBeNull();
  expect(view.queryByRole("button", { name: "Move to new keys" })).toBeNull();
});

it("asks for nothing while the Labs switch is off", async () => {
  const { view, request } = mount("local_operator", false);
  await waitForSolid(() =>
    expect(view.container.textContent).toContain(
      "OpenClaw ID is off. Turn it on in Settings → Labs.",
    ),
  );
  expect(request).not.toHaveBeenCalled();
});
