/* @vitest-environment jsdom */

import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { OPENCLAW_ID_CALLBACK_KEY_PREFIX } from "../../lib/openclaw-id/callback-contract.ts";
import type { OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { openClawIdMenuEntries, selectOpenClawIdMenuValue } from "./account-menu.tsx";

function status(overrides: Partial<OpenClawIdStatusResult> = {}): OpenClawIdStatusResult {
  return {
    status: { state: "on" },
    link: { linked: false },
    channel: "local_operator",
    owner: true,
    services: {
      issuerUrl: "https://issuer.example.test/api/auth",
      discoveryUrl: "https://discovery.example.test",
      loaderDomain: "claws.example.test",
      clientId: "control-ui",
    },
    ...overrides,
  };
}

// Builds the section inside a root, as the identity menu's memo does.
function menu(current: OpenClawIdStatusResult | null) {
  return createRoot((dispose) => {
    const entries = openClawIdMenuEntries(current);
    dispose();
    return entries;
  });
}

// The selectable rows of the section, by label.
function rows(entries: ReturnType<typeof openClawIdMenuEntries>) {
  return entries
    .filter((entry) => !("kind" in entry))
    .map((entry) => entry as { id: string; label: string; disabled?: boolean });
}

// The text of the section's non-interactive lines.
function texts(entries: ReturnType<typeof openClawIdMenuEntries>) {
  return entries
    .filter((entry) => "kind" in entry && entry.kind === "content")
    .map((entry) => ((entry as { content: unknown }).content as HTMLElement).textContent ?? "")
    .filter(Boolean);
}

function labels(entries: ReturnType<typeof openClawIdMenuEntries>) {
  return rows(entries).map((row) => row.label);
}

const ACCOUNT = { sub: "acct-1", email: "owner@example.test", name: "Owner", exp: 4_102_444_800 };

describe("OpenClaw ID account menu", () => {
  afterEach(() => {
    selectOpenClawIdMenuValue("openclaw-id:sign-out", {
      status: null,
      client: null,
      basePath: "",
      onNavigate: () => {},
    });
    vi.restoreAllMocks();
  });

  it("is hidden while the Labs flag is off", () => {
    expect(menu(null)).toEqual([]);
  });

  it("signed out: local operator, sign-in, Make reachable and People", () => {
    const entries = menu(status());
    expect(texts(entries)).toContain("Local operator · Not signed in · this computer only");
    expect(texts(entries)).toContain("Your conversations stay on this computer");
    expect(rows(entries).map((row) => row.label)).toEqual([
      "Sign in with OpenClaw ID",
      "Make reachable",
      "People",
    ]);
    expect(rows(entries).every((row) => !row.disabled)).toBe(true);
  });

  it("keeps sign-in and Make reachable local to this machine", () => {
    const entries = rows(menu(status({ channel: "tunnel" })));
    expect(entries.find((row) => row.label === "Sign in with OpenClaw ID")?.disabled).toBe(true);
    expect(entries.find((row) => row.label === "Make reachable")?.disabled).toBe(true);
    expect(entries.find((row) => row.label === "People")?.disabled).toBeFalsy();
  });

  it("offers Regenerate owner key only on direct loopback of a linked claw", () => {
    const linked = { linked: true, hostname: "studio-e61zr.crabd.xyz" };
    expect(labels(menu(status({ link: linked })))).toContain("Regenerate owner key");
    expect(labels(menu(status({ channel: "tunnel", link: linked })))).not.toContain(
      "Regenerate owner key",
    );
    expect(labels(menu(status({ channel: null, link: linked })))).not.toContain(
      "Regenerate owner key",
    );
    expect(labels(menu(status()))).not.toContain("Regenerate owner key");
  });

  it("explains a frozen claw next to Regenerate owner key", () => {
    const frozen = { linked: true, hostname: "studio-e61zr.crabd.xyz", frozen: true };
    expect(texts(menu(status({ link: frozen }))).join(" ")).toContain(
      "Conflicting owner-key changes reached this claw",
    );
    expect(texts(menu(status({ channel: "tunnel", link: frozen }))).join(" ")).not.toContain(
      "Conflicting owner-key changes",
    );
  });

  it("offers People and Your devices only to an owner", () => {
    const linked = { linked: true, hostname: "studio-e61zr.crabd.xyz" };
    const member = labels(menu(status({ channel: "tunnel", owner: false, link: linked })));
    expect(member).not.toContain("People");
    expect(member).not.toContain("Your devices");
    const owner = labels(menu(status({ channel: "tunnel", owner: true, link: linked })));
    expect(owner).toEqual(expect.arrayContaining(["People", "Your devices"]));
  });

  it("signs in through the popup and shows the account until sign-out", async () => {
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.action === "account_begin") {
        return { authorizationUrl: "https://issuer.example.test/authorize?x=1", state: "s1" };
      }
      return { account: ACCOUNT, idToken: "id-token" };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const current = status({ link: { linked: true, hostname: "studio-e61zr.crabd.xyz" } });

    selectOpenClawIdMenuValue("openclaw-id:sign-in", {
      status: current,
      client,
      basePath: "",
      onNavigate: () => {},
    });
    await vi.waitFor(() => expect(popup.location.href).toContain("issuer.example.test"));
    expect(request).toHaveBeenCalledWith("openclawId.authority", {
      action: "account_begin",
      redirectUri: `${window.location.origin}/openclaw-id/callback`,
    });
    // The callback popup writes its result; this tab hears it as a storage event.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `${OPENCLAW_ID_CALLBACK_KEY_PREFIX}s1`,
        newValue: JSON.stringify({ state: "s1", code: "the-code", error: null }),
      }),
    );
    await vi.waitFor(() =>
      expect(labels(menu(current))).toEqual([
        "Signed in to OpenClaw ID as owner@example.test",
        "studio is reachable",
        "Your devices",
        "Regenerate owner key",
        "People",
        "Sign out of OpenClaw ID",
      ]),
    );
    expect(texts(menu(current))).toEqual(
      expect.arrayContaining([
        "https://studio-e61zr.crabd.xyz",
        "End-to-end encrypted · relays can't read it",
      ]),
    );
    expect(request).toHaveBeenLastCalledWith("openclawId.authority", {
      action: "account_complete",
      state: "s1",
      code: "the-code",
    });

    selectOpenClawIdMenuValue("openclaw-id:sign-out", {
      status: current,
      client,
      basePath: "",
      onNavigate: () => {},
    });
    await vi.waitFor(() => expect(labels(menu(current))[0]).toBe("Sign in with OpenClaw ID"));
  });

  it("opens the People plugin page", () => {
    const onNavigate = vi.fn();
    const handled = selectOpenClawIdMenuValue("openclaw-id:people", {
      status: status(),
      client: null,
      basePath: "",
      onNavigate,
    });
    expect(handled).toBe(true);
    const [route, location] = onNavigate.mock.calls[0]!;
    expect(route).toBe("plugin");
    expect(`${location.pathname}${location.search}`).toContain("openclaw-id-access");
    expect(
      selectOpenClawIdMenuValue("command:settings", {
        status: null,
        client: null,
        basePath: "",
        onNavigate,
      }),
    ).toBe(false);
  });
});
