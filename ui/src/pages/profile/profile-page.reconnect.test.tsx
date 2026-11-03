/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";
import { disconnectedGitHub, mockRpc } from "./profile-rpc.test-support.ts";

it("admits the canonical model-account profile and updates its label without reloading accounts", async () => {
  const initial = createDeferred<{ profile: typeof modelAccountProfile }>();
  let profile = modelAccountProfile;
  const request = mockRpc({
    "users.self": () =>
      request.mock.calls.filter(([name]) => name === "users.self").length === 1
        ? initial.promise
        : { profile },
    "users.listModelAccounts": () => ({
      profileId: profile.id,
      accounts: [
        {
          authProfileId: "openai:personal",
          provider: "openai",
          label: "Personal account",
          authType: "oauth",
          selected: false,
        },
      ],
      links: [],
    }),
    "users.prefs.get": () => ({ status: "ok", entries: {} }),
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "merged-profile-alias",
    name: "Presence label",
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
  const page = mountProfilePage(harness.context);
  await waitForSolid(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1),
  );
  expect(request.mock.calls.some(([method]) => method === "users.listModelAccounts")).toBe(false);
  initial.resolve({ profile });
  await waitForSolid(() => expect(page.textContent).toContain("Personal account"));
  expect(request).toHaveBeenCalledWith("users.listModelAccounts", { profileId: profile.id });
  const accounts = page.querySelector("openclaw-model-accounts");
  const account = accounts?.querySelector('[data-auth-profile-id="openai:personal"]');
  expect(account).not.toBeNull();
  expect(accounts?.textContent).toContain("Ada");

  profile = { ...profile, displayName: "Augusta Ada" };
  const refresh = page.querySelector<HTMLButtonElement>(".profile-refresh")!;
  await waitForSolid(() => expect(refresh.disabled).toBe(false));
  refresh.click();
  await waitForSolid(() => expect(accounts?.textContent).toContain("Augusta Ada"));
  expect(accounts?.querySelector('[data-auth-profile-id="openai:personal"]')).toBe(account);
  expect(
    request.mock.calls.filter(([method]) => method === "users.listModelAccounts"),
  ).toHaveLength(1);
});

it("retains the name draft and loaded profile through a same-client blip, but retires them for another identity", async () => {
  let profile = modelAccountProfile;
  const request = mockRpc({
    "users.self": () => ({ profile }),
    "users.listModelAccounts": () => ({ profileId: profile.id, accounts: [], links: [] }),
    "users.prefs.get": () => ({ status: "ok", entries: {} }),
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
    name: "Ada",
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
  const page = mountProfilePage(harness.context);
  const input = () => page.querySelector<HTMLInputElement>(".identity-name-control input");
  const save = () => page.querySelector<HTMLButtonElement>(".identity-name-control button");
  await waitForSolid(() => expect(input()).toMatchObject({ value: "Ada", disabled: false }));
  input()!.value = "Ada draft";
  input()!.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  harness.emitConnected(false);
  flush();
  expect(input()?.value).toBe("Ada draft");
  expect(page.textContent).toContain("ada@example.test");
  expect(save()?.disabled).toBe(true);
  const reads = request.mock.calls.filter(([method]) => method === "users.self").length;
  harness.emitSnapshot({ phase: "connected", selfUser: undefined });
  flush();
  expect(input()?.value).toBe("Ada draft");
  expect(save()?.disabled).toBe(true);
  expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(reads);
  harness.emitSnapshot({ selfUser: { id: modelAccountProfile.id, name: "Ada" } });
  await waitForSolid(() => {
    expect(input()?.value).toBe("Ada draft");
    expect(save()?.disabled).toBe(false);
  });
  profile = { ...modelAccountProfile, id: "profile-2", displayName: "Grace" };
  harness.emitSnapshot({ selfUser: { id: "profile-2", name: "Grace" } });
  await waitForSolid(() => expect(input()?.value).toBe("Grace"));
});

it.each(["operator.read", "operator.sessions.read", "operator.sessions.write"])(
  "retires loaded profile details and a pending refresh when %s access is revoked",
  async (scope) => {
    const pending = createDeferred<{ profile: typeof modelAccountProfile }>();
    let reads = 0;
    const request = mockRpc({
      "users.self": () => {
        reads += 1;
        return reads === 2 ? pending.promise : { profile: modelAccountProfile };
      },
      "users.prefs.get": () => ({ status: "ok", entries: {} }),
      "users.github.status": () => disconnectedGitHub,
    });
    const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
      id: modelAccountProfile.id,
      name: "Ada",
    });
    harness.emitHello(gatewayHelloForMethods([], [scope]));
    const loadProfile = vi.spyOn(harness.context.gateway, "loadSelfProfile");
    const page = mountProfilePage(harness.context);
    await waitForSolid(() => expect(page.textContent).toContain("ada@example.test"));
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")).toMatchObject({
      value: "Ada",
      disabled: false,
    });
    expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
      true,
    );
    expect(page.querySelector('input[type="file"]')).not.toBeNull();
    await waitForSolid(() =>
      expect(page.querySelector<HTMLButtonElement>(".profile-refresh")?.disabled).toBe(false),
    );
    page.querySelector<HTMLButtonElement>(".profile-refresh")!.click();
    await waitForSolid(() => expect(reads).toBe(2));
    harness.emitHello(gatewayHelloForMethods([], []));
    flush();
    expect(page.textContent).not.toContain("ada@example.test");
    expect(page.querySelector(".identity-name-control")).toBeNull();
    pending.resolve({ profile: modelAccountProfile });
    await loadProfile.mock.results[1]!.value;
    flush();
    expect(page.textContent).not.toContain("ada@example.test");
    expect(page.querySelector(".identity-name-control")).toBeNull();
    expect(reads).toBe(2);

    harness.emitHello(gatewayHelloForMethods([], [scope]));
    await waitForSolid(() => expect(page.textContent).toContain("ada@example.test"));
    expect(reads).toBe(3);
    expect(request.mock.calls.some(([method]) => method === "users.list")).toBe(false);
    expect(
      request.mock.calls.some(([method]) =>
        ["users.setDisplayName", "users.setAvatar", "users.prefs.set"].includes(method),
      ),
    ).toBe(false);
  },
);

it("retires a pending identity read and Gateway subscription when unmounted", async () => {
  const pending = createDeferred<{ profile: typeof modelAccountProfile }>();
  const request = mockRpc({ "users.self": () => pending.promise });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
    name: "Ada",
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
  const loadProfile = vi.spyOn(harness.context.gateway, "loadSelfProfile");
  const page = mountProfilePage(harness.context);
  await waitForSolid(() => expect(loadProfile).toHaveBeenCalledTimes(1));

  page.unmount();
  pending.resolve({ profile: modelAccountProfile });
  await loadProfile.mock.results[0]!.value;
  flush();
  harness.emitSnapshot({ selfUser: { id: "replacement", name: "Grace" } });
  flush();

  expect(loadProfile).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.some(([method]) => method === "users.prefs.get")).toBe(false);
});
