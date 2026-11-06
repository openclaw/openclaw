/* @vitest-environment jsdom */
import { createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { signOutOfOpenClawId } from "../../lib/openclaw-id/account.ts";
import { OPENCLAW_ID_CALLBACK_KEY_PREFIX } from "../../lib/openclaw-id/callback-contract.ts";
import type { OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { showConfirmDialog } from "../confirm-dialog.ts";
import type { MenuItem } from "../solid/menu.tsx";
import {
  openClawIdMenuEntries,
  openClawIdMenuIdentity,
  openClawIdSignOutEntries,
  selectOpenClawIdMenuValue,
} from "./account-menu.tsx";

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
function menu(current: OpenClawIdStatusResult | null) {
  return createRoot((dispose) => {
    const entries = [...openClawIdMenuEntries(current), ...openClawIdSignOutEntries(current)];
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

async function signIn(current: OpenClawIdStatusResult, previewAccess = true) {
  const popup = { location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.action === "account_begin"
      ? { authorizationUrl: "https://issuer.example.test/authorize", state: "s1" }
      : { account, idToken: "test-token", previewAccess },
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
  await vi.waitFor(() =>
    expect(menu(current).labels).toContain(
      previewAccess ? "Sign out of OpenClaw ID" : "Sign out / use another account",
    ),
  );
  return request;
}

describe("approved OpenClaw ID account menu", () => {
  beforeEach(() => vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true));

  afterEach(() => {
    signOutOfOpenClawId();
    flush();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a denied account instead of offering or starting Make reachable", async () => {
    const current = status();
    current.services.environment = "staging";
    const request = await signIn(current, false);
    expect(menu(current).text).toContain("owner@example.test isn't enabled yet");
    expect(menu(current).text).toContain("Private preview · staging");
    expect(menu(current).labels).not.toContain("Turn on remote access");
    selectOpenClawIdMenuValue("openclaw-id:make-reachable", {
      status: current,
      client: { request } as unknown as GatewayBrowserClient,
      basePath: "",
    });
    expect(request.mock.calls.map(([, params]) => params.action)).toEqual([
      "account_begin",
      "account_complete",
    ]);
  });

  it("keeps an existing claw available when its account cannot create new claws", async () => {
    const current = status({ link: linked });
    await signIn(current, false);
    expect(menu(current).text).toContain("Remote access on");
    expect(menu(current).labels).toContain("Your devices");
  });

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
