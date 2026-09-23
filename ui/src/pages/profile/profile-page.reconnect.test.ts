/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
  type ProfilePageElement,
} from "./profile-page.test-support.ts";

const draft = "Profile layout control: unsaved";
const selfUser = { id: modelAccountProfile.id, name: modelAccountProfile.displayName! };
const readOnlyHello = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: ["operator.read"] },
  features: { methods: ["users.self"] },
} as ApplicationGatewaySnapshot["hello"];

function nameInput(page: ParentNode) {
  return page.querySelector<HTMLInputElement>(".identity-name-control input")!;
}

function saveButton(page: ParentNode) {
  return page.querySelector<HTMLButtonElement>('.identity-name-control button[type="submit"]')!;
}

async function editName(page: ProfilePageElement, value: string) {
  nameInput(page).value = value;
  nameInput(page).dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
}

async function mountIdentity() {
  const read = vi.fn(async () => ({ profile: { ...modelAccountProfile } }));
  const save = vi.fn(async () => ({ profile: { ...modelAccountProfile, displayName: draft } }));
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return read();
    }
    if (method === "users.setDisplayName") {
      return save();
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], selfUser);
  const page = mountProfilePage(harness.context);
  await waitForFast(() => expect(nameInput(page)?.disabled).toBe(false));
  return {
    ...harness,
    page,
    read,
    save,
    request,
    disconnect() {
      harness.emitSnapshot({ phase: "reconnecting", selfUser: null, hello: null });
    },
    reconnect(patch: Partial<ApplicationGatewaySnapshot> = {}) {
      harness.emitSnapshot({ phase: "connected", selfUser, hello: null, ...patch });
    },
  };
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "reconciles an external name change across Refresh and reconnect (dirty: %s)",
  async (dirty) => {
    const h = await mountIdentity();
    if (dirty) {
      await editName(h.page, draft);
    }
    const before = nameInput(h.page);
    h.read.mockResolvedValue({ profile: { ...modelAccountProfile, displayName: "External name" } });
    h.page.querySelector<HTMLButtonElement>(".profile-refresh")!.click();
    await waitForFast(() => expect(h.read).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(nameInput(h.page)?.disabled).toBe(false));
    expect(nameInput(h.page)).toBe(before);
    expect(nameInput(h.page).value).toBe(dirty ? draft : "External name");

    h.disconnect();
    await h.page.updateComplete;
    expect(nameInput(h.page)).toBeNull();
    const refresh = createDeferred<{ profile: UserProfile }>();
    h.read.mockReturnValueOnce(refresh.promise);
    h.reconnect();
    await h.page.updateComplete;
    expect(nameInput(h.page)).toBeNull();
    refresh.resolve({ profile: { ...modelAccountProfile, displayName: "Another external name" } });
    await waitForFast(() => expect(nameInput(h.page)?.disabled).toBe(false));
    expect(nameInput(h.page).value).toBe(dirty ? draft : "Another external name");
    expect(saveButton(h.page).disabled).toBe(!dirty);
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.save).not.toHaveBeenCalled();
  },
);

it("retains a reconnect draft after a failed read without admitting stale form submissions", async () => {
  const h = await mountIdentity();
  await editName(h.page, draft);
  const retiredForm = h.page.querySelector(".identity-name-control")!;
  const submit = () => retiredForm.dispatchEvent(new Event("submit", { cancelable: true }));
  h.disconnect();
  submit();
  h.read.mockRejectedValueOnce(new Error("Profile temporarily unavailable"));
  h.reconnect();
  submit();
  await waitForFast(() => expect(h.page.textContent).toContain("Profile temporarily unavailable"));
  submit();
  expect(nameInput(h.page)).toBeNull();
  expect(h.save).not.toHaveBeenCalled();

  h.page.querySelector<HTMLButtonElement>(".profile-refresh")!.click();
  await waitForFast(() => expect(nameInput(h.page)?.value).toBe(draft));
  expect(saveButton(h.page).disabled).toBe(false);
  saveButton(h.page).click();
  await waitForFast(() => expect(h.save).toHaveBeenCalledTimes(1));
});

it("keeps the draft through repeated reconnects and ignores an older read", async () => {
  const h = await mountIdentity();
  await editName(h.page, draft);
  const oldRead = createDeferred<{ profile: UserProfile }>();
  const newRead = createDeferred<{ profile: UserProfile }>();
  h.read.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
  h.disconnect();
  await h.page.updateComplete;
  h.reconnect();
  await h.page.updateComplete;
  h.disconnect();
  await h.page.updateComplete;
  h.reconnect();
  await h.page.updateComplete;
  newRead.resolve({ profile: { ...modelAccountProfile, displayName: "Current saved name" } });
  await waitForFast(() => expect(nameInput(h.page)?.value).toBe(draft));
  await editName(h.page, "Newer local edit");
  oldRead.resolve({ profile: { ...modelAccountProfile, displayName: "Stale saved name" } });
  await oldRead.promise;
  await h.page.updateComplete;
  expect(nameInput(h.page).value).toBe("Newer local edit");
  expect(saveButton(h.page).disabled).toBe(false);
  expect(h.read).toHaveBeenCalledTimes(3);
});

it.each(
  [
    { dirty: false, value: "Newer local edit" },
    { dirty: true, value: "Newer local edit" },
    { dirty: true, value: "Ada" },
  ].flatMap((scenario) => [
    { ...scenario, reconnect: false },
    { ...scenario, reconnect: true },
  ]),
)(
  "keeps a subsequent input during Refresh (dirty: $dirty, value: $value, reconnect: $reconnect)",
  async ({ dirty, value, reconnect }) => {
    const h = await mountIdentity();
    if (dirty) {
      await editName(h.page, draft);
    }
    const refresh = createDeferred<{ profile: UserProfile }>();
    h.read.mockReturnValueOnce(refresh.promise);
    h.page.querySelector<HTMLButtonElement>(".profile-refresh")!.click();
    // A queued input event can land before the loading render disables the field.
    await editName(h.page, value);
    const external = { profile: { ...modelAccountProfile, displayName: "External name" } };
    if (reconnect) {
      h.disconnect();
      await h.page.updateComplete;
      h.read.mockResolvedValue(external);
      h.reconnect();
      await waitForFast(() => expect(nameInput(h.page)?.disabled).toBe(false));
    }
    refresh.resolve(external);
    await refresh.promise;
    await waitForFast(() => expect(nameInput(h.page)?.disabled).toBe(false));
    expect(nameInput(h.page).value).toBe(value);
    expect(h.read).toHaveBeenCalledTimes(reconnect ? 3 : 2);
  },
);

it.each(["identity", "absent", "client", "access", "route"] as const)(
  "retires the reconnect draft when %s changes, even if the original identity returns",
  async (boundary) => {
    const h = await mountIdentity();
    await editName(h.page, draft);
    h.disconnect();
    await h.page.updateComplete;
    if (boundary === "route") {
      const parent = h.page.parentElement!;
      h.page.remove();
      parent.append(h.page);
    } else {
      h.reconnect({
        ...(boundary === "identity" ? { selfUser: { id: "different-person" } } : {}),
        ...(boundary === "absent" ? { selfUser: null } : {}),
        ...(boundary === "client"
          ? { client: createTestGatewayClient(h.request as GatewayBrowserClient["request"]) }
          : {}),
        ...(boundary === "access" ? { hello: readOnlyHello } : {}),
      });
      await h.page.updateComplete;
      if (boundary === "absent" || boundary === "access") {
        expect(nameInput(h.page)).toBeNull();
        expect(h.read).toHaveBeenCalledTimes(1);
      }
      h.disconnect();
    }
    h.reconnect();
    await waitForFast(() => expect(nameInput(h.page)?.disabled).toBe(false));
    expect(nameInput(h.page).value).toBe(modelAccountProfile.displayName);
    expect(saveButton(h.page).disabled).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not transfer a draft to a merged profile (reconnect: %s)",
  async (reconnect) => {
    const h = await mountIdentity();
    await editName(h.page, draft);
    h.read.mockResolvedValue({
      profile: { ...modelAccountProfile, id: "canonical-person", displayName: "Canonical name" },
    });
    if (reconnect) {
      h.disconnect();
      h.reconnect();
    } else {
      h.page.querySelector<HTMLButtonElement>(".profile-refresh")!.click();
    }
    await waitForFast(() => expect(h.read).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(nameInput(h.page)?.disabled).toBe(false));
    expect(nameInput(h.page).value).toBe("Canonical name");
    expect(saveButton(h.page).disabled).toBe(true);
  },
);

it.each(["committed", "pending", "failed"] as const)(
  "reconciles a %s Save across reconnect without replaying the write",
  async (outcome) => {
    const h = await mountIdentity();
    const save = createDeferred<{ profile: UserProfile }>();
    h.save.mockReturnValueOnce(save.promise);
    await editName(h.page, draft);
    saveButton(h.page).click();
    expect(h.save).toHaveBeenCalledTimes(1);
    h.disconnect();
    await h.page.updateComplete;
    if (outcome === "committed") {
      h.read.mockResolvedValue({ profile: { ...modelAccountProfile, displayName: draft } });
    }
    h.reconnect();
    await waitForFast(() => expect(nameInput(h.page)?.disabled).toBe(false));
    expect(nameInput(h.page).value).toBe(draft);
    expect(saveButton(h.page).disabled).toBe(outcome === "committed");
    await editName(h.page, "Newer local edit");
    if (outcome === "failed") {
      save.reject(new Error("Retired save failed"));
    } else {
      save.resolve({ profile: { ...modelAccountProfile, displayName: draft } });
    }
    await save.promise.catch(() => undefined);
    await h.page.updateComplete;
    expect(nameInput(h.page).value).toBe("Newer local edit");
    expect(h.page.querySelector('[role="alert"]')).toBeNull();
    expect(h.context.gateway.snapshot.selfUser?.name).toBe(selfUser.name);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(2);
  },
);
