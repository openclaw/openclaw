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
    for (const channel of ["tunnel", undefined] as const) {
      expect(await service.unlink.preview(channel)).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
      expect(await service.unlink.run(channel, claw.clawId)).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
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
      expect(await service.unlink.run("local_operator", claw.clawId)).toMatchObject({
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
      expect(await service.unlink.run("local_operator", claw.clawId)).toMatchObject({
        ok: true,
        discovery: "pending",
      });
      expect(claw.authority.current()?.authority).toBeNull();
      expect(await service.linkSummary()).toEqual({
        linked: false,
        pendingUnlinks: [{ hostname: "studio-k7x2q.claws.example.test" }],
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

  it("returns the committed pending unlink after one deadline despite runtime resumption", async () => {
    const { claw, service } = await clawWithMember();
    const deadlines: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    const arrived = Promise.withResolvers<AbortController>();
    const duplicate = Promise.withResolvers<"duplicate">();
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.pathname.endsWith(`/claws/${claw.clawId}/unlink`)) {
        return new Response("", { status: 404 });
      }
      attempts += 1;
      if (attempts > 1) {
        duplicate.resolve("duplicate");
      }
      arrived.resolve(deadlines.at(-1)!);
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new Error("request aborted", { cause: signal?.reason }));
        if (signal?.aborted) {
          abort();
        } else {
          signal?.addEventListener("abort", abort, { once: true });
        }
      });
    });
    const request = service.unlink.run("local_operator", claw.clawId);
    try {
      const deadline = await arrived.promise;
      await service.reconcileRuntimePolicy();
      deadline.abort(new DOMException("Discovery deadline", "TimeoutError"));
      expect(await Promise.race([request, duplicate.promise])).toMatchObject({
        ok: true,
        discovery: "pending",
      });
      expect(attempts).toBe(1);
      expect(claw.authority.current()?.pending_unlinks).toHaveLength(1);
      expect(claw.authority.current()?.authority).toBeNull();
    } finally {
      await service.stop();
      await request;
    }
  });

  it("treats Discovery's `unlinked` answer to a resend as done", async () => {
    const { claw, service } = await clawWithMember();
    discovery(() =>
      Response.json({ error: { code: "unlinked", message: "unlinked" } }, { status: 410 }),
    );
    try {
      expect(await service.unlink.run("local_operator", claw.clawId)).toMatchObject({
        discovery: "confirmed",
      });
      expect(claw.authority.current()?.pending_unlinks).toBeUndefined();
    } finally {
      await service.stop();
    }
  });

  it("unlinks locally a claw no registration was sent for, and waits once one was", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority, config);
    const sent = await linkedClaw();
    await sent.authority.registrationSending(sent.clawId);
    const next = serviceFor(sent.authority, config);
    try {
      expect(await service.unlink.run("local_operator", claw.clawId)).toMatchObject({
        ok: true,
        discovery: "local_only",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(claw.authority.current()?.pending_unlinks).toBeUndefined();
      expect(await service.linkSummary()).toEqual({ linked: false });
      // Sent but unconfirmed: Discovery may hold the claw, so the unlink waits for it.
      expect(await next.service.unlink.run("local_operator", sent.clawId)).toMatchObject({
        ok: true,
        discovery: "pending",
      });
      expect(await next.service.linkSummary()).toMatchObject({
        pendingUnlinks: [{ hostname: "studio-k7x2q.claws.example.test" }],
      });
    } finally {
      await next.service.stop();
      await service.stop();
    }
  });

  it("does not unlink as local only a claw whose registration is already on its way", async () => {
    const claw = await linkedClaw();
    const racing: { enabled: boolean; discoveryUrl: string; relayUrl?: string } = {
      ...config,
      relayUrl: "https://relay.example.test",
    };
    const { service } = serviceFor(claw.authority, racing);
    const registration = Promise.withResolvers<void>();
    let registered = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1/claws" && init?.method === "POST") {
        await registration.promise;
        registered = true;
        return Response.json({ owner_account_id: "owner" });
      }
      // Discovery answers the unlink before the registration lands, then retires the claw.
      return url.pathname.endsWith("/unlink") && registered
        ? confirmed()
        : Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
    });
    try {
      const publishing = service.publish("ENROLL-CODE");
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
      delete racing.relayUrl;
      expect(await service.unlink.run("local_operator", claw.clawId)).toMatchObject({
        ok: true,
        discovery: "refused",
        discoveryCode: "not_found",
      });
      registration.resolve();
      await publishing;
      expect(registered).toBe(true);
      expect(await service.linkSummary()).toMatchObject({
        pendingUnlinks: [{ hostname: "studio-k7x2q.claws.example.test", refused: "not_found" }],
      });
    } finally {
      registration.resolve();
      await service.stop();
    }
  });

  it("marks a registration sent only when one is sent, for the claw still linked", async () => {
    const racing: { enabled: boolean; discoveryUrl: string; relayUrl?: string } = {
      ...config,
      relayUrl: "https://relay.example.test",
    };
    const lookup = Promise.withResolvers<void>();
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (paths.length > 1 && url.pathname.endsWith("/registration")) {
        await lookup.promise;
      }
      return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
    });
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority, racing);
    try {
      // Without a link code nothing is registered, so the claw stays never registered.
      expect(await service.publish()).toMatchObject({ state: "needs_enrollment_code" });
      // With one, an unlink while Discovery is still being asked stops the registration.
      const publishing = service.publish("ENROLL-CODE");
      await vi.waitFor(() => expect(paths).toHaveLength(2));
      delete racing.relayUrl;
      expect(await service.unlink.run("local_operator", claw.clawId)).toMatchObject({
        discovery: "local_only",
      });
      lookup.resolve();
      expect(await publishing).toMatchObject({ state: "failed", code: "claw_changed" });
      expect(paths.filter((path) => path === "POST /v1/claws")).toEqual([]);
    } finally {
      lookup.resolve();
      await service.stop();
    }
  });

  it("unlinks only the claw whose warning was confirmed", async () => {
    const { claw, service } = await clawWithMember();
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      expect(await service.unlink.run("local_operator", "f".repeat(32))).toMatchObject({
        ok: false,
        code: "claw_changed",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(claw.authority.current()?.authority?.members.member).toBeDefined();
    } finally {
      await service.stop();
    }
  });

  it("keeps a refused unlink, reports it, and never sends it again", async () => {
    const { claw, service } = await clawWithMember();
    const { fetch } = discovery(() =>
      Response.json({ error: { code: "invalid_statement", message: "x" } }, { status: 400 }),
    );
    try {
      expect(await service.unlink.run("local_operator", claw.clawId)).toMatchObject({
        ok: true,
        discovery: "refused",
        discoveryCode: "invalid_statement",
      });
      expect(await service.linkSummary()).toEqual({
        linked: false,
        pendingUnlinks: [
          { hostname: "studio-k7x2q.claws.example.test", refused: "invalid_statement" },
        ],
      });
      const sent = fetch.mock.calls.length;
      await service.reconcileRuntimePolicy();
      expect(fetch.mock.calls.length).toBe(sent);
    } finally {
      await service.stop();
    }
  });

  it("still sends the unlink and restarts remote access when removing someone fails", async () => {
    const { claw, service, effects } = await clawWithMember();
    if (!effects.cancelRuns) {
      throw new Error("serviceFor provides cancelRuns");
    }
    vi.mocked(effects.cancelRuns).mockRejectedValue(new Error("runs stuck"));
    const { received } = discovery(confirmed);
    try {
      expect(await service.unlink.run("local_operator", claw.clawId)).toMatchObject({
        ok: true,
        discovery: "confirmed",
        followUpError: expect.stringContaining("runs stuck"),
      });
      expect(received).toHaveLength(1);
      expect(service.status()).toMatchObject({ state: "unconfigured" });
    } finally {
      await service.stop();
    }
  });

  it("drops publication progress for the unlinked claw that lands afterwards", async () => {
    const { claw, service } = await clawWithMember();
    discovery(confirmed);
    try {
      await service.unlink.run("local_operator", claw.clawId);
      await claw.authority.recordDiscovery(
        { owner_account_id: "owner", published_binding_seq: 1 },
        claw.clawId,
      );
      expect(claw.authority.current()?.discovery.owner_account_id).toBeNull();
    } finally {
      await service.stop();
    }
  });

  it("still shows an unconfirmed unlink after this computer is linked again", async () => {
    const { claw, service } = await clawWithMember();
    discovery(() => {
      throw new TypeError("fetch failed");
    });
    try {
      await service.unlink.run("local_operator", claw.clawId);
      const pending = claw.authority.current()!.pending_unlinks!;
      await service.stop();
      // A later link: a linked record that still carries the earlier pending unlink.
      const relinked = await linkedClaw();
      await relinked.store.write({ ...relinked.authority.current()!, pending_unlinks: pending });
      const next = serviceFor(createOpenClawIdAuthority(relinked.store), { enabled: true });
      expect(await next.service.linkSummary()).toMatchObject({
        linked: true,
        pendingUnlinks: [{ hostname: "studio-k7x2q.claws.example.test" }],
      });
      await next.service.stop();
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
      expect(await moved.service.unlink.run("local_operator", claw.clawId)).toMatchObject({
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
