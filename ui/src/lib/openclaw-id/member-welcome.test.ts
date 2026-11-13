/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { landDueMemberOnNewSession, memberWelcomeOwner } from "./member-welcome.ts";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-openclaw-id-enabled");
  document.documentElement.removeAttribute("data-openclaw-control-ui-base-path");
  delete window["__openclawTransport"];
});

// A member connection as the Gateway reports it.
function arrive(displayName: string | null) {
  const request = vi.fn(async () => ({
    link: { linked: true, hostname: "harbor-a1b2.claws.example.test" },
    connection: {
      kind: "member",
      role: "operator",
      accountId: "acct-sam",
      email: "sam.rivera@example.test",
      displayName,
      invitedBy: { name: "Demo owner", email: null },
    },
  }));
  // SAFETY: the owner reads only the snapshot and subscription of this Gateway.
  const gateway = {
    snapshot: {
      phase: "connected",
      client: { request } as unknown as GatewayBrowserClient,
      selfUser: { id: "profile-sam" },
    },
    subscribe: () => () => {},
  } as unknown as ApplicationGateway;
  const owner = memberWelcomeOwner(gateway);
  const published = vi.fn();
  owner.subscribe(published);
  return { owner, published, gateway };
}

it("is due for a member named from their email until they answer in this browser", async () => {
  const first = arrive("sam.rivera");
  expect(first.owner.state.kind).toBe("none");
  await vi.waitFor(() => expect(first.owner.state.kind).toBe("due"));
  expect(first.owner.state).toMatchObject({
    welcome: { currentName: "sam.rivera", inviter: "Demo owner", hostname: expect.any(String) },
  });
  first.owner.answer();
  expect(first.owner.state.kind).toBe("none");

  const again = arrive("sam.rivera");
  await vi.waitFor(() => expect(again.published).toHaveBeenCalled());
  expect(again.owner.state.kind).toBe("none");
});

it("is never due for a member who chose a name", async () => {
  const named = arrive("Sam Rivera");
  await vi.waitFor(() => expect(named.published).toHaveBeenCalled());
  expect(named.owner.state.kind).toBe("none");
});

it("offers neither composer nor welcome on an unsettled tunnel connection until its status is known", async () => {
  document.documentElement.setAttribute("data-openclaw-id-enabled", "true");
  document.documentElement.setAttribute("data-openclaw-control-ui-base-path", "");
  window["__openclawTransport"] = {} as never;
  const tunnel = arrive("Sam Rivera");
  expect(tunnel.owner.state.kind).toBe("pending");
  await vi.waitFor(() => expect(tunnel.owner.state.kind).toBe("none"));
  // The settled answer lets this browser's next load show its composer at once.
  expect(arrive("Sam Rivera").owner.state.kind).toBe("none");
});

it("lands a due member on a new session once, and only from the default landing", async () => {
  const deepLink = arrive("sam.rivera");
  const kept = vi.fn();
  landDueMemberOnNewSession(deepLink.gateway, {
    isDefaultLanding: async () => false,
    openNewSession: kept,
  });
  await vi.waitFor(() => expect(deepLink.owner.state.kind).toBe("due"));
  await Promise.resolve();
  expect(kept).not.toHaveBeenCalled();

  const landing = arrive("sam.rivera");
  const opened = vi.fn();
  landDueMemberOnNewSession(landing.gateway, {
    isDefaultLanding: async () => true,
    openNewSession: opened,
  });
  await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
  landing.owner.answer();
  expect(opened).toHaveBeenCalledTimes(1);

  const named = arrive("Sam Rivera");
  const untouched = vi.fn();
  landDueMemberOnNewSession(named.gateway, {
    isDefaultLanding: async () => true,
    openNewSession: untouched,
  });
  await vi.waitFor(() => expect(named.published).toHaveBeenCalled());
  expect(untouched).not.toHaveBeenCalled();
});

it("asks again after a reconnect when the first status read was lost", async () => {
  let listener = () => {};
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("closed"))
    .mockResolvedValue({
      link: { linked: true },
      connection: {
        kind: "member",
        role: "operator",
        accountId: "acct-sam",
        email: "sam.rivera@example.test",
        displayName: "sam.rivera",
      },
    });
  // SAFETY: the owner reads only the snapshot and subscription of this Gateway.
  const client = { request } as unknown as GatewayBrowserClient;
  const connected = { phase: "connected", client, selfUser: { id: "profile-sam" } };
  const gateway = {
    snapshot: connected as object,
    subscribe: (next: () => void) => {
      listener = next;
      return () => {};
    },
  };
  // SAFETY: as above; the snapshot is replaced to model the store's reconnect.
  const owner = memberWelcomeOwner(gateway as unknown as ApplicationGateway);
  owner.subscribe(() => {});
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  // The store keeps the same client across its reconnect.
  gateway.snapshot = { phase: "reconnecting", client };
  listener();
  gateway.snapshot = connected;
  listener();
  await vi.waitFor(() => expect(owner.state.kind).toBe("due"));
  expect(request).toHaveBeenCalledTimes(2);
});
