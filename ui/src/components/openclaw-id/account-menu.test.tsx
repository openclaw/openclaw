/* @vitest-environment jsdom */
import { createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness, flushMicrotasks } from "../../app/overlays-access.test-support.ts";
import { signOutOfOpenClawId } from "../../lib/openclaw-id/account.ts";
import { OPENCLAW_ID_CALLBACK_KEY_PREFIX } from "../../lib/openclaw-id/callback-contract.ts";
import type { OpenClawIdPublication, OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessions } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { showConfirmDialog } from "../confirm-dialog.ts";
import type { MenuItem } from "../solid/menu.tsx";
import {
  openClawIdMenuEntries,
  openClawIdMenuIdentity,
  openClawIdSignOutEntries,
  selectOpenClawIdMenuValue,
} from "./account-menu.tsx";
import { OpenClawIdIdentityMenu } from "./identity-menu.tsx";

// mock-isolation: the confirmation dialog is answered directly so menu actions run without a modal.
vi.mock("../confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

function status(overrides: Partial<OpenClawIdStatusResult> = {}): OpenClawIdStatusResult {
  return {
    status: { state: "on" },
    link: { linked: false },
    channel: "local_operator",
    owner: true,
    connection: { kind: "local" },
    ownerDeviceCount: 2,
    services: {
      issuerUrl: "https://issuer.example.test",
      discoveryUrl: "https://discovery.example.test",
      loaderDomain: "claws.example.test",
      clientId: "control-ui",
    },
    ...overrides,
  };
}

// Read the exact rendered content in the same owned scope as the sidebar memo.
function menu(current: OpenClawIdStatusResult | null, publication?: OpenClawIdPublication) {
  return createRoot((dispose) => {
    const entries = [
      ...openClawIdMenuEntries(current, publication),
      ...openClawIdSignOutEntries(current),
    ];
    const rows = entries.filter((entry): entry is MenuItem => !("kind" in entry));
    const text = entries
      .map((entry) => ("content" in entry ? (entry.content as HTMLElement)?.textContent : ""))
      .join(" ");
    const result = { labels: rows.map((entry) => entry.label), rows, text };
    dispose();
    return result;
  });
}

const linked = { linked: true, hostname: "studio-e61zr.crabd.xyz" };
const account = {
  sub: "never-display-this-id",
  email: "owner@example.test",
  name: "Owner",
  exp: 4_102_444_800,
};

async function signIn(current: OpenClawIdStatusResult) {
  const popup = { location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.action === "account_begin"
      ? { authorizationUrl: "https://issuer.example.test/authorize", state: "s1" }
      : { account, idToken: "test-token" },
  );
  selectOpenClawIdMenuValue("openclaw-id:sign-in", {
    status: current,
    client: { request } as unknown as GatewayBrowserClient,
    basePath: "",
  });
  await vi.waitFor(() => expect(popup.location.href).toContain("issuer.example.test"));
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: `${OPENCLAW_ID_CALLBACK_KEY_PREFIX}s1`,
      newValue: JSON.stringify({ state: "s1", code: "test-code", error: null }),
    }),
  );
  await vi.waitFor(() => expect(menu(current).labels).toContain("Sign out of OpenClaw ID"));
  return request;
}

describe("approved OpenClaw ID account menu", () => {
  beforeEach(() => vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true));

  afterEach(() => {
    cleanupSolid();
    disposeSidebarContextLifecycles();
    signOutOfOpenClawId();
    flush();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { retirement: "client", code: "needs_link_code", label: "Publish", remedy: "Publish new keys" },
    {
      retirement: "revision",
      code: "binding_superseded",
      label: "Newer keys",
      remedy: "Move to new keys",
    },
  ])(
    "keeps $code on a rejected refresh and discards it on $retirement retirement",
    async ({ retirement, code, label, remedy }) => {
      const current = status({ link: linked });
      await signIn(current);
      const pending = Promise.withResolvers<OpenClawIdPublication>();
      let publication: OpenClawIdPublication | Promise<OpenClawIdPublication> = {
        state: "failed",
        code,
        message: "publication failed",
      };
      const request = vi.fn(async (method: string) => {
        if (method === "openclawId.status") {
          return current;
        }
        if (method === "openclawId.people") {
          return { link: { ...linked, publication: await publication } };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const client = createTestGatewayClient(request);
      const h = createGatewayHarness(client);
      const context = createContext(h.gateway, createSessions("main", []));
      const stopEvents = vi.fn();
      const subscribeEvents = h.gateway.subscribeEvents.bind(h.gateway);
      vi.spyOn(h.gateway, "subscribeEvents").mockImplementation((listener) => {
        const stop = subscribeEvents(listener);
        return () => {
          stopEvents();
          return stop();
        };
      });
      const onClose = vi.fn();
      const view = mountSolid(
        () => (
          <OpenClawIdIdentityMenu
            position={{ x: 0, bottom: 400, width: 280 }}
            nativeGatewaySnapshot={null}
            canPairDevice={false}
            basePath=""
            gatewayVersion={null}
            updateAvailable={false}
            canRetryConnection={false}
            themeMode="system"
            triggerWidth={280}
            onClose={onClose}
            onNavigate={() => {}}
            onPairMobile={() => {}}
          />
        ),
        { wrapper: createSolidApplicationContextProvider(context).wrapper },
      );
      const warning = () => view.container.querySelector('[data-attention="true"]');
      await waitForSolid(() => expect(warning()?.textContent).toContain(label));
      const menuElement = view.container.querySelector(".sidebar-identity-menu");
      await waitForSolid(() => expect(menuElement?.getAttribute("data-phase")).toBe("open"));
      h.emitEvent("sessions.changed", {});
      flush();
      expect(request.mock.calls.filter(([method]) => method === "openclawId.people")).toHaveLength(
        1,
      );
      publication = pending.promise;
      h.emitEvent("openclawId.people.changed", {});
      await waitForSolid(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "openclawId.people"),
        ).toHaveLength(2),
      );
      expect(warning()?.querySelector("span")?.style.color).toBe("var(--warn)");
      pending.reject(new Error("People unavailable"));
      await expect(request.mock.results.at(-1)?.value).rejects.toThrow("People unavailable");
      await flushMicrotasks();
      flush();
      expect(warning()?.textContent).toContain(label);
      expect(view.getByText(remedy)).toBeDefined();
      publication = { state: "published", ownerAccountId: "owner", snapshotSeq: 2 };
      h.emitEvent("openclawId.people.changed", {});
      await waitForSolid(() => expect(warning()).toBeNull());
      publication = { state: "failed", code: "binding_superseded", message: "superseded" };
      h.emitEvent("openclawId.people.changed", {});
      await waitForSolid(() => expect(warning()?.textContent).toContain("Newer keys"));
      expect(view.container.querySelector(".sidebar-identity-menu")).toBe(menuElement);
      expect(menuElement?.getAttribute("data-phase")).toBe("open");
      expect(onClose).not.toHaveBeenCalled();
      const retired = Promise.withResolvers<OpenClawIdPublication>();
      publication = retired.promise;
      h.emitEvent("openclawId.people.changed", {});
      await waitForSolid(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "openclawId.people"),
        ).toHaveLength(5),
      );
      const replacement = vi.fn(async (method: string) => {
        if (method === "openclawId.status") {
          return current;
        }
        throw new Error("New owner's People unavailable");
      });
      const replacementClient = createTestGatewayClient(replacement);
      if (retirement === "client") {
        h.update({ client: replacementClient });
      } else {
        client.request = replacementClient.request.bind(replacementClient);
        h.gateway.connectionRevision++;
        h.update({});
      }
      await waitForSolid(() => expect(warning()).toBeNull());
      expect(stopEvents).toHaveBeenCalledOnce();
      retired.resolve({ state: "failed", code: "binding_superseded", message: "old owner" });
      await request.mock.results.at(-1)?.value;
      h.emitEvent("openclawId.people.changed", {});
      flush();
      expect(warning()).toBeNull();
      await waitForSolid(() => expect(replacement).toHaveBeenCalledWith("openclawId.people", {}));
      const replacementCalls = replacement.mock.calls.length;
      const nonOwner = vi.fn(async () => ({ ...current, owner: false }));
      h.update({ client: createTestGatewayClient(nonOwner) });
      await waitForSolid(() => expect(stopEvents).toHaveBeenCalledTimes(2));
      h.emitEvent("openclawId.people.changed", {});
      flush();
      expect(warning()).toBeNull();
      expect(nonOwner).toHaveBeenCalledExactlyOnceWith("openclawId.status", {});
      const calls = request.mock.calls.length;
      view.unmount();
      expect(stopEvents).toHaveBeenCalledTimes(2);
      h.emitEvent("openclawId.people.changed", {});
      flush();
      expect(request).toHaveBeenCalledTimes(calls);
      expect(replacement).toHaveBeenCalledTimes(replacementCalls);
      expect(nonOwner).toHaveBeenCalledOnce();
    },
  );

  it("is absent when the Labs flag is off", () => {
    expect(menu(null).labels).toEqual([]);
    expect(menu(status({ status: { state: "off" } })).text.trim()).toBe("");
  });

  it("local signed-out shows only the sign-in button and keeps the local identity", () => {
    const current = status({ link: linked });
    expect(openClawIdMenuIdentity(current)).toEqual({
      name: "Local access",
      detail: "This computer",
    });
    expect(menu(current).labels).toEqual(["Sign in with OpenClaw ID"]);
    const entries = menu(current);
    expect(entries.text.trim()).toBe("");
    expect(entries.rows[0]?.icon).toBeUndefined();
    expect(entries.rows[0]?.render).toBeTypeOf("function");
    expect(menu(current).text).not.toMatch(/People|\bAccess\b|Make reachable|Regenerate|Unlink/);
  });

  it("does not allow loopback sign-in over an untrusted connection", () => {
    expect(
      menu(status({ channel: null, owner: false, connection: { kind: "none" } })).rows[0]?.disabled,
    ).toBe(true);
  });

  it("remote owner shows verified account, encrypted device, count, and no local actions", () => {
    const current = status({
      channel: "tunnel",
      link: linked,
      connection: {
        kind: "owner",
        deviceLabel: "Owner phone",
        ownerAccountId: account.sub,
        accountEmail: account.email,
        accountName: account.name,
      },
    });
    expect(openClawIdMenuIdentity(current)).toEqual({
      name: "Owner",
      detail: "owner@example.test · Owner",
    });
    expect(menu(current).labels).toEqual(["Your devices"]);
    expect(menu(current).text).toContain("End-to-end encryptedOwner phone · this device");
    expect(menu(current).text).not.toMatch(
      /reachable|crabd|People|\bAccess\b|Sign in|Regenerate|never-display/,
    );
    expect((menu(current).rows[0]?.details as HTMLElement | undefined)?.textContent).toBe("2");
  });

  it.each(["viewer", "operator"] as const)(
    "remote %s shows own email, role and known inviter with no owner items",
    (role) => {
      const current = status({
        channel: "tunnel",
        owner: false,
        link: linked,
        connection: {
          kind: "member",
          role,
          accountId: "member-id",
          email: "member@example.test",
          displayName: "Member",
          invitedBy: { name: "Owner", email: "owner@example.test" },
        },
      });
      expect(openClawIdMenuIdentity(current)).toEqual({
        name: "member@example.test",
        detail: `${role === "viewer" ? "Viewer" : "Operator"} on studio`,
      });
      expect(menu(current).labels).toEqual([]);
      expect(menu(current).text).toContain("Invited by Owner");
      expect(menu(current).text).not.toMatch(
        /People|\bAccess\b|Your devices|Regenerate|Remote access|Sign in/,
      );
    },
  );

  it("omits the unknown inviter rather than inventing one", () => {
    const current = status({
      channel: "tunnel",
      owner: false,
      connection: {
        kind: "member",
        role: "viewer",
        accountId: "secret-id",
        email: null,
        displayName: null,
      },
    });
    expect(openClawIdMenuIdentity(current).name).toBe("OpenClaw ID account");
    expect(menu(current).text).not.toContain("Invited by");
  });

  it("does not claim Owner when tunnel identity is unavailable", () => {
    const current = status({ channel: "tunnel", owner: false, connection: { kind: "none" } });
    expect(openClawIdMenuIdentity(current)).toEqual({
      name: "OpenClaw ID account",
      detail: "End-to-end encrypted",
    });
    expect(menu(current).labels).toEqual([]);
  });

  it("uses the account fallback, never a raw ID, when the owner email is missing", () => {
    const current = status({
      channel: "tunnel",
      link: linked,
      connection: { kind: "owner", deviceLabel: null, ownerAccountId: account.sub },
    });
    expect(openClawIdMenuIdentity(current)).toEqual({
      name: "OpenClaw ID account",
      detail: "Owner",
    });
    expect(menu(current).text).not.toContain(account.sub);
  });

  it.each([true, false])(
    "local linked reflects relayOnline=%s and offers a copy link and devices",
    async (relayOnline) => {
      const current = status({
        link: linked,
        status: { state: "on", tunnel: { state: "running", relayOnline } },
        connection: { kind: "local", accountEmail: account.email, accountName: account.name },
      });
      await signIn(current);
      expect(openClawIdMenuIdentity(current).detail).toBe("owner@example.test · Local access");
      expect(menu(current).labels).toEqual([
        "Copy claw link",
        "Move to new keys",
        "Your devices",
        "Sign out of OpenClaw ID",
      ]);
      expect(menu(current).text).toContain(
        `Remote access onstudio-e61zr.crabd.xyz${relayOnline ? "Online" : "Offline"}`,
      );
      expect(menu(current).text).not.toMatch(/People|\bAccess\b|Regenerate|Turn off remote|Unlink/);
    },
  );

  it("only offers Make reachable after sign-in, without trusting browser profile storage", async () => {
    const current = status();
    const request = await signIn(current);
    expect(menu(current).labels).toEqual(["Turn on remote access", "Sign out of OpenClaw ID"]);
    expect(openClawIdMenuIdentity(current).name).toBe("OpenClaw ID account");
    expect(request).toHaveBeenLastCalledWith("openclawId.authority", {
      action: "account_complete",
      state: "s1",
      code: "test-code",
    });
    selectOpenClawIdMenuValue("openclaw-id:sign-out", {
      status: current,
      client: null,
      basePath: "",
    });
    expect(showConfirmDialog).toHaveBeenCalledWith({
      title: "Sign out of OpenClaw ID",
      message: "This claw stays reachable for you and the people you've invited.",
      confirmLabel: "Sign out of OpenClaw ID",
    });
    await vi.waitFor(() => expect(menu(current).labels).toEqual(["Sign in with OpenClaw ID"]));
  });

  it("keeps the local account when the reachability confirmation is cancelled", async () => {
    const current = status({ link: linked });
    await signIn(current);
    vi.mocked(showConfirmDialog).mockResolvedValueOnce(false);
    selectOpenClawIdMenuValue("openclaw-id:sign-out", {
      status: current,
      client: null,
      basePath: "",
    });
    await Promise.resolve();
    flush();
    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(menu(current).labels).toContain("Sign out of OpenClaw ID");
  });

  it("copies the canonical HTTPS remote link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    selectOpenClawIdMenuValue("openclaw-id:copy-link", {
      status: status({ link: linked }),
      client: null,
      basePath: "",
    });
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://studio-e61zr.crabd.xyz"),
    );
  });

  it("warns about unusable or superseded keys on this computer, each with its fix", async () => {
    const refused = status({
      link: linked,
      status: { state: "keys_refused", key: "gateway", reason: "keys_missing" },
    });
    await signIn(refused);
    const keys = menu(refused);
    expect(keys.text).toContain("Remote access is off: a key file is missing");
    expect(keys.text).not.toContain("Remote access on");
    expect(keys.labels).toContain("Move to new keys");
    const superseded = menu(status({ link: linked }), {
      state: "failed",
      code: "binding_superseded",
      message: "x",
    });
    expect(superseded.text).toContain("Newer keys are in use for this claw");
    expect(superseded.labels).toContain("Move to new keys");
    const pending = menu(status({ link: linked }), {
      state: "failed",
      code: "needs_link_code",
      message: "x",
    });
    expect(pending.text).toContain("New keys aren't published yet");
    expect(pending.labels).toContain("Publish new keys");
    // Over the tunnel nothing here can be fixed: no warnings, no local actions.
    const remote = menu(status({ channel: "tunnel", link: linked, connection: { kind: "none" } }), {
      state: "failed",
      code: "binding_superseded",
      message: "x",
    });
    expect(remote.text).not.toContain("Newer keys");
    expect(remote.labels).not.toContain("Move to new keys");
  });

  it("publishes new keys with a link code fetched from the signed-in account", async () => {
    const current = status({ link: linked });
    await signIn(current);
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      params.action === "account_link_code"
        ? { code: "ACCOUNT-CODE" }
        : { publication: { state: "published", ownerAccountId: "a", snapshotSeq: 3 } },
    );
    selectOpenClawIdMenuValue("openclaw-id:publish-keys", {
      status: current,
      client: { request } as unknown as GatewayBrowserClient,
      basePath: "",
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("openclawId.authority", {
        action: "publish",
        enrollmentCode: "ACCOUNT-CODE",
      }),
    );
    expect(request).toHaveBeenCalledWith("openclawId.authority", {
      action: "account_link_code",
      idToken: "test-token",
    });
  });

  it("offers remote sign-out only with the loader's real service worker", () => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage: vi.fn() } } });
    expect(menu(status({ channel: "tunnel", link: linked })).labels).toContain(
      "Sign out of OpenClaw ID",
    );
    expect(
      selectOpenClawIdMenuValue("command:settings", { status: null, client: null, basePath: "" }),
    ).toBe(false);
  });
});
