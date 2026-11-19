/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createConnectedContext } from "../profile/profile-page.test-support.tsx";
import { OpenClawIdPage } from "./openclaw-id-page.tsx";

const account = vi.hoisted(() => ({ current: null as null | { email: string } }));
vi.mock("../../lib/openclaw-id/account.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/openclaw-id/account.ts")>()),
  openClawIdAccount: () => account.current,
}));

afterEach(() => {
  account.current = null;
  cleanupSolid();
});

// The two requirement rows' answers, in order: on this computer, signed in as the owner.
const requirements = (container: HTMLElement) =>
  [...container.querySelectorAll(".settings-status")]
    .map((node) => node.textContent?.trim())
    .filter((text) => text !== "Published");
const resetButton = (view: ReturnType<typeof mount>["view"]) =>
  view.getByRole("button", { name: "Reset…" }) as HTMLButtonElement;

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

it("offers Reset owner access on the claw's computer, signed in with the owner account", async () => {
  account.current = { email: "owner@example.test" };
  const { view } = mount("local_operator");
  await waitForSolid(() => expect(view.getByText("Reset…")).toBeDefined());
  expect(view.container.textContent).toContain("studio-k7x2q.crabd.xyz");
  expect(view.container.textContent).toContain("Published");
  expect(view.container.textContent).toContain(
    "Reset owner access needs both of these, so only the owner, at this claw's computer, can do it:",
  );
  expect(requirements(view.container)).toEqual(["Yes", "Signed in as owner@example.test"]);
  expect(resetButton(view).disabled).toBe(false);
});

it("explains the owner-account requirement and keeps Reset off without a sign-in", async () => {
  const { view } = mount("local_operator");
  await waitForSolid(() => expect(view.getByText("Reset…")).toBeDefined());
  expect(view.container.textContent).toContain("Signed in with the account that owns this claw");
  expect(requirements(view.container)).toEqual(["Yes", "Not signed in"]);
  expect(resetButton(view).disabled).toBe(true);
});

it("explains the direct-connection requirement and keeps Reset off over the tunnel", async () => {
  account.current = { email: "owner@example.test" };
  const { view } = mount("tunnel");
  await waitForSolid(() =>
    expect(view.container.textContent).toContain("On the computer that runs this claw"),
  );
  expect(view.container.textContent).toContain(
    "Remote, tunneled and proxied connections can't reset",
  );
  expect(requirements(view.container)).toEqual(["No", "Signed in as owner@example.test"]);
  expect(resetButton(view).disabled).toBe(true);
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
