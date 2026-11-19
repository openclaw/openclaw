import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatIrohEndpointKey,
  parseStatement,
  verifyClawUnlink,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

// Unlinking a claw from its own computer (OCF-281): members wiped, link cleared, Discovery told
// now or as soon as it answers.
afterEach(() => {
  vi.restoreAllMocks();
});

// No relayUrl: remote access stays `unconfigured`, so no tunnel child starts in these tests.
const config = { enabled: true, discoveryUrl: "https://discovery.example.test" };

// A linked claw with one member who has two browsers, registered at Discovery.
async function clawWithMember() {
  const claw = await linkedClaw();
  await claw.authority.recordDiscovery({ owner_account_id: "owner", published_binding_seq: 1 });
  const peers = [1, 2].map((fill) => formatIrohEndpointKey(new Uint8Array(32).fill(fill)));
  const { service, effects, log } = serviceFor(claw.authority, config);
  const added = await service.submitStatement(
    "local_operator",
    await claw.sign({
      op: "add",
      account_id: "member",
      role: "operator",
      peer_keys: [peers[0]!],
      invite_id: null,
    }),
  );
  expect(added.ok).toBe(true);
  expect(
    (
      await service.submitStatement(
        "local_operator",
        await claw.sign({
          op: "add_member_device",
          account_id: "member",
          peer_key: peers[1]!,
          device_pub: claw.prep.k_gw,
          label: "laptop",
        }),
      )
    ).ok,
  ).toBe(true);
  return { claw, service, effects, log, peers, binding: claw.authority.current()!.binding! };
}

// Discovery's unlink endpoint: answers with `respond` and records each ClawUnlink it gets.
function discovery(respond: () => Response | Promise<Response>) {
  const received: SignedStatement<"ClawUnlink">[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!/^\/v1\/claws\/[0-9a-f]{32}\/unlink$/.test(url.pathname)) {
      return new Response("", { status: 404 });
    }
    // SAFETY: the Discovery client sends the JSON request body as bytes.
    const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
      unlink: unknown;
    };
    const parsed = parseStatement(body.unlink, "ClawUnlink");
    if (parsed.ok) {
      received.push(parsed.statement);
    }
    return await respond();
  });
  return { fetch, received };
}

const confirmed = () =>
  Response.json({ claw_id: "x", hostname: "studio-k7x2q.claws.example.test", unlinked_at: 1 });

describe("unlink", () => {
  it("is refused over the tunnel, and changes nothing", async () => {
    const { claw, service } = await clawWithMember();
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const step of [service.unlink.preview, service.unlink.run]) {
      expect(await step("tunnel")).toMatchObject({ ok: false, code: "not_local_operator" });
      expect(await step(undefined)).toMatchObject({ ok: false, code: "not_local_operator" });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(claw.authority.current()?.authority?.members.member).toBeDefined();
    await service.stop();
  });

  it("warns with live counts, then removes everyone and retires the claw at Discovery", async () => {
    const { claw, service, effects, peers, binding } = await clawWithMember();
    const { received } = discovery(confirmed);
    try {
      expect(await service.unlink.preview("local_operator")).toEqual({
        claw_id: claw.clawId,
        hostname: "studio-k7x2q.claws.example.test",
        people: 1,
        devices: 3,
        ownerDevices: 1,
        memberDevices: 2,
        nodes: 0,
      });
      expect(await service.unlink.run("local_operator")).toMatchObject({
        ok: true,
        unlinked: true,
        hostname: "studio-k7x2q.claws.example.test",
        removed: { people: 1, devices: 3 },
        removal: { devices: 3, connectionsClosed: 3 },
        discovery: "confirmed",
      });
      // Discovery got one ClawUnlink for the binding it stores, signed by that binding's K_gw.
      expect(received).toHaveLength(1);
      expect(await verifyClawUnlink(received[0]!, binding.body)).toMatchObject({ ok: true });
      // Every remote session closed; members' runs stopped.
      expect(effects.closeConnections).toHaveBeenCalledWith(
        expect.arrayContaining([...peers, claw.w1].map((key) => `conn-${key.slice(5, 9)}`)),
      );
      expect(effects.cancelRuns).toHaveBeenCalled();
      // The link, binding and membership are gone; this computer starts over as a new claw.
      const record = claw.authority.current()!;
      expect(record).toMatchObject({ authority: null, binding: null, hostname: null });
      expect(record.claw_id).not.toBe(claw.clawId);
      expect(record.pending_unlinks).toBeUndefined();
      expect(record.discovery.owner_account_id).toBeNull();
      expect(await service.linkSummary()).toEqual({ linked: false });
      expect(await service.unlink.preview("local_operator")).toMatchObject({
        ok: false,
        code: "not_linked",
      });
    } finally {
      await service.stop();
    }
  });

  it("unlinks locally when Discovery is unreachable and sends it when Discovery answers", async () => {
    const { claw, service, binding } = await clawWithMember();
    let up = false;
    const { received } = discovery(() => {
      if (!up) {
        throw new TypeError("fetch failed");
      }
      return confirmed();
    });
    try {
      expect(await service.unlink.run("local_operator")).toMatchObject({
        ok: true,
        discovery: "pending",
      });
      expect(claw.authority.current()?.authority).toBeNull();
      expect(await service.linkSummary()).toEqual({
        linked: false,
        pendingUnlinks: ["studio-k7x2q.claws.example.test"],
      });
      // A restart: a new service over the same stored record sends it at start.
      await service.stop();
      up = true;
      const restarted = serviceFor(createOpenClawIdAuthority(claw.store), config, claw.stateDir);
      await restarted.service.reconcileRuntimePolicy();
      await vi.waitFor(async () => {
        expect((await claw.store.read())?.pending_unlinks).toBeUndefined();
      });
      expect(received.at(-1)).toEqual(received[0]);
      expect(await verifyClawUnlink(received[0]!, binding.body)).toMatchObject({ ok: true });
      await restarted.service.stop();
    } finally {
      await service.stop();
    }
  });

  it("treats Discovery's `unlinked` answer to a resend as done", async () => {
    const { claw, service } = await clawWithMember();
    discovery(() =>
      Response.json({ error: { code: "unlinked", message: "unlinked" } }, { status: 410 }),
    );
    try {
      expect(await service.unlink.run("local_operator")).toMatchObject({
        discovery: "confirmed",
      });
      expect(claw.authority.current()?.pending_unlinks).toBeUndefined();
    } finally {
      await service.stop();
    }
  });

  it("waits for a moved binding to be published first", async () => {
    const { claw, service } = await clawWithMember();
    const fetch = vi.spyOn(globalThis, "fetch");
    const record = claw.authority.current()!;
    // A move to new keys committed here (binding 2) that Discovery has not confirmed.
    await claw.store.write({
      ...record,
      binding: { ...record.binding!, body: { ...record.binding!.body, binding_seq: 2 } },
    });
    const moved = serviceFor(createOpenClawIdAuthority(claw.store), config, claw.stateDir);
    try {
      expect(await moved.service.unlink.run("local_operator")).toMatchObject({
        ok: false,
        code: "binding_unpublished",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect((await claw.store.read())?.authority?.members.member).toBeDefined();
    } finally {
      await moved.service.stop();
      await service.stop();
    }
  });
});
