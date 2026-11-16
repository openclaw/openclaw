/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createApplicationConfigCapability,
  type ApplicationConfigCapability,
} from "../app/config.ts";
import { client, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { startOpenClawIdFeatureLifetime } from "../lib/openclaw-id/feature-lifetime.ts";
import type {
  OpenClawIdPeopleLink,
  OpenClawIdPublication,
  OpenClawIdStatusResult,
} from "../lib/openclaw-id/types.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { bindJoinRequestPrompt } from "./openclaw-id/join-request-prompt.tsx";
import { readOpenClawIdAttention } from "./sidebar-attention-openclaw-id.ts";
import { createStore, cronPage } from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";

const status: OpenClawIdStatusResult = {
  status: { state: "keys_refused", key: "gateway", reason: "keys_missing" },
  channel: "local_operator",
  remoteAccessSetup: "local",
  accountSignIn: "popup",
  owner: true,
  link: { linked: true, clawId: "test-claw", hostname: "test.claw.example" },
  services: { issuerUrl: null, discoveryUrl: null, loaderDomain: null },
};
const superseded = { state: "failed", code: "binding_superseded", message: "superseded" } as const;
let store: SidebarAttentionStore | undefined;
let endFeature = () => {};
let unbindPrompt = () => {};
beforeEach(() => {
  endFeature = startOpenClawIdFeatureLifetime();
});
afterEach(() => {
  unbindPrompt();
  endFeature();
  store?.dispose();
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function setup(
  read: () => Promise<OpenClawIdStatusResult>,
  requests: Pick<OpenClawIdPeopleLink, "invites" | "nodeInvites" | "browserRequests" | "recoveryUses"> = {},
) {
  let enabled = true;
  let publication: OpenClawIdPublication = superseded;
  let listed = requests;
  const changes = new Set<Parameters<ApplicationConfigCapability["subscribe"]>[0]>();
  const defaults = createApplicationConfigCapability({ resourceBasePath: "" }).current;
  const config = {
    get current() {
      return { ...defaults, openclawIdEnabled: enabled };
    },
    subscribe(listener: Parameters<ApplicationConfigCapability["subscribe"]>[0]) {
      changes.add(listener);
      return () => changes.delete(listener);
    },
  } satisfies Pick<ApplicationConfigCapability, "current" | "subscribe">;
  const request = vi.fn(async (method: string) => {
    if (method === "openclawId.status") {
      return read();
    }
    if (method === "openclawId.people") {
      return { link: { publication, ...listed } };
    }
    if (method === "cron.list") {
      return cronPage();
    }
    if (method === "cron.status") {
      return { enabled: true, jobs: 0 };
    }
    return { ts: 1, providers: [] };
  });
  const harness = createGatewayHarness(client(request));
  harness.update({ selfUser: { id: "alice", name: "Alice" } });
  store = createStore(harness.gateway, undefined, undefined, config);
  store.activate(SidebarAttentionStoreOwner);
  return {
    ...harness,
    request,
    recovered() {
      publication = { state: "published", ownerAccountId: "fixture", snapshotSeq: 1 };
      harness.emitEvent("openclawId.people.changed", {});
    },
    disable() {
      enabled = false;
      changes.forEach((listener) => listener(config.current));
    },
    requestsChanged(next: typeof requests) {
      listed = next;
      harness.emitEvent("openclawId.people.changed", {});
    },
  };
}

const seconds = (ms: number) => ms / 1000;
function memberRequest(inviteId: string, name: string, decideByMs = Date.now() + 216_000_000) {
  return {
    inviteId,
    label: `${name.toLowerCase()}@example.com`,
    status: "pending" as const,
    pending: {
      requestedAt: seconds(Date.now()),
      decideBy: seconds(decideByMs),
      reported: { email: `${name.toLowerCase()}@example.com`, displayName: name },
    },
  };
}
const tunnelOwner = { ...status, channel: "tunnel" as const, status: { state: "on" as const } };
const recoveryUse = {
  seq: 9,
  accountId: "member-mira",
  memberName: "Mira Example",
  deviceLabel: "Firefox on Linux",
  peerKey: `iroh:${"1".repeat(64)}`,
  peerFp: `fp:${"1".repeat(64)}`,
  usedAt: 1_800_000_000,
};
const promptTitle = () => document.querySelector(".exec-approval-title")?.textContent ?? null;
function press(label: string) {
  [...document.querySelectorAll("button")].find((button) => button.textContent === label)?.click();
}

it.each(["keys_missing", "key_mismatch"] as const)(
  "shows %s in the system inbox",
  async (reason) => {
    const h = setup(async () => ({ ...status, status: { ...status.status, reason } }));
    await waitForFast(() =>
      expect(store?.entries).toMatchObject([
        {
          type: "attention",
          kind: "openClawIdKeys",
          category: "system",
          severity: "error",
          action: { kind: "openClawIdRecovery", label: "Move to new keys" },
        },
      ]),
    );
    expect(h.request.mock.calls.some(([method]) => method === "openclawId.people")).toBe(false);
  },
);

it("shows binding_superseded and clears after recovery", async () => {
  const current = { ...status, status: { state: "on" as const } };
  const h = setup(async () => current);
  await waitForFast(() =>
    expect(store?.entries[0]).toMatchObject({ label: "Newer keys are in use for this claw" }),
  );
  store?.refreshOpenClawId();
  await waitForFast(() =>
    expect(h.request.mock.calls.filter(([method]) => method === "openclawId.people")).toHaveLength(
      2,
    ),
  );
  h.recovered();
  await waitForFast(() => expect(store?.entries).toEqual([]));
});

it("clears on Labs disable and rejects its pending reply", async () => {
  const pending = createDeferred<OpenClawIdStatusResult>();
  let read = async () => status;
  const h = setup(() => read());
  await waitForFast(() => expect(store?.entries).toHaveLength(1));
  read = () => pending.promise;
  store?.refreshOpenClawId();
  const changed = vi.fn();
  const stop = store!.subscribe(changed);
  h.disable();
  expect(store?.entries).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(1);
  changed.mockClear();
  h.request.mockClear();
  h.disable();
  store?.refreshOpenClawId();
  expect(changed).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
  stop();
  pending.resolve(status);
  await pending.promise;
  await Promise.resolve();
  expect(store?.entries).toEqual([]);
});

it("rejects an old connection reply", async () => {
  const pending = createDeferred<OpenClawIdStatusResult>();
  const h = setup(() => pending.promise);
  h.update({ phase: "stopped", client: null });
  pending.resolve(status);
  await pending.promise;
  await Promise.resolve();
  expect(store?.entries).toEqual([]);
  expect(h.request.mock.calls.some(([method]) => method === "openclawId.people")).toBe(false);
});

it("never offers local key recovery to a tunnel caller or an off feature", async () => {
  for (const unavailable of [
    { ...status, channel: "tunnel" as const },
    { ...status, status: { state: "off" as const } },
  ]) {
    const gateway = client(vi.fn(async () => unavailable));
    expect((await readOpenClawIdAttention(gateway, () => true))?.items(Date.now())).toEqual([]);
  }
});

it("tells an owner about join requests and a non-owner nothing", async () => {
  const navigate = vi.fn();
  const requests = {
    invites: [memberRequest("ada", "Ada")],
    nodeInvites: [
      {
        inviteId: "mini",
        label: "Mac mini",
        status: "pending" as const,
        pending: { requestedAt: seconds(Date.now()) - 60, decideBy: seconds(Date.now()) + 600 },
      },
    ],
  };
  const member = setup(async () => ({ ...tunnelOwner, owner: false }), requests);
  unbindPrompt = bindJoinRequestPrompt({ ...member, sidebarAttention: store!, navigate });
  await waitForFast(() => expect(member.request).toHaveBeenCalledWith("openclawId.status", {}));
  await Promise.resolve();
  expect(store?.entries).toEqual([]);
  expect(member.request.mock.calls.some(([method]) => method === "openclawId.people")).toBe(false);
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  unbindPrompt();
  store?.dispose();

  const owner = setup(async () => tunnelOwner, requests);
  unbindPrompt = bindJoinRequestPrompt({ ...owner, sidebarAttention: store!, navigate });
  await waitForFast(() =>
    expect(store?.entries).toMatchObject([
      {
        kind: "openClawIdRequest",
        label: "Ada asked to join",
        meta: { status: "2d left to decide" },
        action: {
          kind: "navigate",
          routeId: "plugin",
          search: "?plugin=openclaw-id-access&id=access",
        },
      },
      { kind: "openClawIdRequest", label: "Mac mini asked to join as a node" },
    ]),
  );
  await waitForFast(() => expect(promptTitle()).toBe("Ada asked to join"));
  expect(document.querySelector(".exec-approval-queue")?.textContent).toBe("1 more waiting");
});

it("prompts once per new request and clears when requests resolve or expire", async () => {
  // Expiry and the countdown run on this clock; the test advances it explicitly.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setTimeout", "clearTimeout"] });
  const navigate = vi.fn();
  const ada = memberRequest("ada", "Ada");
  const h = setup(async () => tunnelOwner, { invites: [ada] });
  unbindPrompt = bindJoinRequestPrompt({ ...h, sidebarAttention: store!, navigate });
  await waitForFast(() => expect(promptTitle()).toBe("Ada asked to join"));
  press("Later");
  await waitForFast(() => expect(promptTitle()).toBeNull());
  h.requestsChanged({ invites: [ada] });
  await waitForFast(() =>
    expect(h.request.mock.calls.filter(([method]) => method === "openclawId.people")).toHaveLength(
      2,
    ),
  );
  await Promise.resolve();
  expect(promptTitle()).toBeNull();
  expect(store?.entries).toHaveLength(1);

  h.requestsChanged({ invites: [memberRequest("bo", "Bo"), ada] });
  await waitForFast(() => expect(promptTitle()).toBe("Bo asked to join"));
  press("Review");
  await waitForFast(() =>
    expect(navigate).toHaveBeenCalledWith("plugin", {
      search: "?plugin=openclaw-id-access&id=access",
    }),
  );

  h.requestsChanged({ invites: [memberRequest("cy", "Cy", Date.now() + 3_600_000), ada] });
  await waitForFast(() => expect(promptTitle()).toBe("Cy asked to join"));
  // Cy's request expires without a Gateway event.
  vi.advanceTimersByTime(3_600_000);
  await waitForFast(() =>
    expect(store?.entries).toMatchObject([
      { label: "Ada asked to join", meta: { status: "2d left to decide" } },
    ]),
  );
  // Ada was already shown to this profile, so the prompt closes rather than falling back to her.
  await waitForFast(() => expect(promptTitle()).toBeNull());

  // Another owner profile on this browser has not been shown Ada.
  h.update({ selfUser: { id: "bob", name: "Bob" } });
  await waitForFast(() => expect(promptTitle()).toBe("Ada asked to join"));
  h.requestsChanged({ invites: [] });
  await waitForFast(() => expect(store?.entries).toEqual([]));
  await waitForFast(() => expect(promptTitle()).toBeNull());
});

it("schedules the next time-left change, not only the expiry", async () => {
  const now = Date.now();
  const ada = memberRequest("ada", "Ada", now + 216_000_000);
  const gateway = client(
    vi.fn(async (method: string) =>
      method === "openclawId.status" ? tunnelOwner : { link: { invites: [ada] } },
    ),
  );
  const attention = await readOpenClawIdAttention(gateway, () => true);
  // Days left: the Inbox re-renders hourly, so an idle row's time left stays current.
  expect(attention?.nextChangeAt(now)).toBe(now + 3_600_000);
  // The last hour counts down every few seconds, then the row expires.
  const lastHour = now + 216_000_000 - 1_800_000;
  expect(attention?.nextChangeAt(lastHour)).toBe(lastHour + 5_000);
  expect(attention?.nextChangeAt(now + 216_000_000)).toBeUndefined();
});

it.each(["local_operator", "tunnel"] as const)(
  "projects bounded member browser notices with a usable %s owner action",
  async (channel) => {
    const now = Date.now();
    const request = {
      requestId: "request-one",
      accountId: "raw-account-id",
      displayName: "Alice Example",
      email: "alice@example.test",
      label: "Safari on iOS",
      location: "Example City",
      requestedAt: Math.floor(now / 1000),
      expiresAt: Math.floor(now / 1000) + 1800,
    };
    const gateway = client(
      vi.fn(async (method: string) =>
        method === "openclawId.status"
          ? { ...tunnelOwner, channel }
          : { link: { browserRequests: [request] } },
      ),
    );
    const attention = await readOpenClawIdAttention(gateway, () => true);
    expect(attention?.items(now)).toMatchObject([
      {
        kind: "openClawIdBrowserRequest",
        label: "Browser request from Alice Example",
        detail:
          "Safari on iOS · 30m left\nalice@example.test\nLocation reported by OpenClaw ID: Example City",
        arrivedAtMs: request.requestedAt * 1000,
        action: { kind: "openClawIdBrowserApproval", remote: channel === "tunnel" },
      },
    ]);
    expect(JSON.stringify(attention?.items(now))).not.toContain("raw-account-id");
    expect(attention?.nextChangeAt(now)).toBe(now + 5000);
    expect(attention?.items(request.expiresAt * 1000)).toEqual([]);
    expect(attention?.nextChangeAt(request.expiresAt * 1000)).toBeUndefined();
  },
);

it("does not read browser requests for a non-owner, even with administrative scopes", async () => {
  const request = vi.fn(async () => ({ ...tunnelOwner, owner: false }));
  const attention = await readOpenClawIdAttention(client(request), () => true);
  expect(attention?.items(Date.now())).toEqual([]);
  expect(request.mock.calls).toEqual([["openclawId.status", {}]]);
});

it.each(["tunnel", null] as const)(
  "does not read or show recovery history to a non-owner (%s)",
  async (channel) => {
    const h = setup(async () => ({ ...tunnelOwner, channel, owner: false }), {
      recoveryUses: [recoveryUse],
    });
    await waitForFast(() => expect(h.request).toHaveBeenCalledWith("openclawId.status", {}));
    expect(store?.entries).toEqual([]);
    expect(h.request).not.toHaveBeenCalledWith("openclawId.people", {});
  },
);

it("shows each recovery use with a literal time and dismisses only that use across refreshes", async () => {
  const uses = { recoveryUses: [recoveryUse] };
  const h = setup(async () => tunnelOwner, uses);
  await waitForFast(() => expect(store?.entries).toHaveLength(1));
  const entry = store!.entries[0]!;
  expect(entry).toMatchObject({
    type: "attention",
    kind: "openClawIdRecoveryUse",
    severity: "warning",
    requiresAction: true,
    label: "Mira Example used a recovery kit",
    detail: "Firefox on Linux was added. Review access in Access → People.",
    arrivedAtMs: 1_800_000_000_000,
    meta: { status: expect.stringMatching(/2027/) },
    action: {
      kind: "navigate",
      routeId: "plugin",
      search: `?plugin=openclaw-id-access&id=access&${new URLSearchParams({ "p.member": recoveryUse.accountId, "p.device": recoveryUse.peerKey })}`,
    },
  });
  expect(entry.dismissal).toEqual({
    kind: "openClawIdRecoveryUse",
    signature: JSON.stringify(["test-claw", 9]),
  });
  store!.dismiss(entry.dismissal!);
  expect(store!.entries).toEqual([]);
  h.requestsChanged({ recoveryUses: [recoveryUse, { ...recoveryUse, seq: 10 }] });
  await waitForFast(() => expect(store?.entries).toHaveLength(1));
  expect(store!.entries[0]!.dismissal?.signature).toBe(JSON.stringify(["test-claw", 10]));
  // Reconnection starts other inventories before the owner-only history read completes.
  store!.dispose();
  const reloaded = setup(async () => tunnelOwner, uses);
  await waitForFast(() => expect(reloaded.request).toHaveBeenCalledWith("openclawId.people", {}));
  await Promise.resolve();
  expect(store!.entries).toEqual([]);
});
