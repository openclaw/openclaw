import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { applyMailboxMessage, createMailboxSink } from "./mailbox-reader.js";
import { linkedClaw, memoryStore, nowSeconds, serviceFor } from "./openclaw-id.test-support.js";

// The real mailbox dispatcher, serialized metadata owner and owner People projection; no network.
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup() {
  const store = memoryStore();
  const claw = await linkedClaw(store);
  await claw.authority.recordDiscovery({ owner_account_id: "owner" });
  const peer = formatIrohEndpointKey(new Uint8Array(32).fill(42));
  expect(
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: "member",
        role: "viewer",
        peer_keys: [peer],
        invite_id: null,
      }),
      "tunnel",
    ),
  ).toMatchObject({ ok: true });
  await store.profiles.save({
    accountId: "member",
    name: "Canonical Member",
    email: "member@example.test",
  });
  const sink = {
    ...createMailboxSink(claw.authority, claw.clawId),
    submit: vi.fn((statement: unknown) => claw.authority.submit(statement, "mailbox")),
  };
  const mail = (id = "a".repeat(32)): MailboxMessage => ({
    message_id: "mail",
    claw_id: claw.clawId,
    to: "gateway",
    from: {
      account_id: "member",
      email: "spoof@example.test",
      display_name: "Spoof",
      device_fp: null,
      reported_by: "openclaw-id",
    },
    location_hint: "Reported place",
    received_at: nowSeconds(),
    expires_at: nowSeconds() + 86400,
    payload: {
      kind: "member_browser_request",
      request_id: id,
      action: "request",
      member_account_id: "member",
      label: "New browser",
      expires_at: nowSeconds() + 1800,
    },
  });
  return {
    claw,
    store,
    sink,
    mail,
    deliver: (message: MailboxMessage) => applyMailboxMessage(message, sink),
  };
}

describe("member browser Inbox metadata", () => {
  it("projects only current member display, admits nothing, and retires only the matching request", async () => {
    const h = await setup();
    const save = vi.spyOn(h.store.profiles, "save");
    const before = structuredClone(h.claw.authority.current()!.authority);
    const changed = vi.fn();
    h.claw.authority.onPeopleChanged(changed);
    const { service } = serviceFor(h.claw.authority);
    try {
      const message = h.mail();
      expect(await h.deliver(message)).toMatchObject([{ ok: true, events: [] }]);
      const view = await service.linkStatus();
      expect(view.browserRequests).toEqual([
        {
          requestId: "a".repeat(32),
          accountId: "member",
          displayName: "Canonical Member",
          email: "member@example.test",
          label: "New browser",
          location: "Reported place",
          requestedAt: message.received_at,
          expiresAt: message.received_at + 1800,
        },
      ]);
      expect(h.claw.authority.current()!.authority).toEqual(before);
      expect(save).not.toHaveBeenCalled();
      expect(h.sink.submit).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledOnce();
      expect(await h.deliver(message)).toMatchObject([{ ok: true }]);
      expect(changed).toHaveBeenCalledOnce();
      const cancel = h.mail("b".repeat(32));
      cancel.from.account_id = "owner";
      if (cancel.payload.kind !== "member_browser_request") {
        throw new Error("fixture");
      }
      cancel.payload.action = "cancel";
      expect(await h.deliver(cancel)).toMatchObject([{ ok: true }]);
      expect((await service.linkStatus()).browserRequests).toMatchObject([
        { requestId: "a".repeat(32) },
      ]);
      cancel.payload.request_id = "a".repeat(32);
      expect(await h.deliver(cancel)).toMatchObject([{ ok: true }]);
      expect((await service.linkStatus()).browserRequests).toEqual([]);
      expect(await h.deliver(message)).toMatchObject([{ ok: false, code: "replayed" }]);
      expect(h.claw.authority.current()!.authority).toEqual(before);
    } finally {
      await service.stop();
    }
  });

  it("refuses malformed, expired, inflated-clock, nonmember and removed-member mail without writes", async () => {
    const h = await setup();
    const write = vi.spyOn(h.store, "write");
    const base = h.mail();
    const invalid = [
      { ...base, claw_id: "f".repeat(32) },
      { ...base, to: "owners" },
      { ...base, received_at: nowSeconds() + 1 },
      { ...base, payload: { ...base.payload, expires_at: nowSeconds() + 1801 } },
      { ...base, payload: { ...base.payload, expires_at: nowSeconds() } },
      { ...base, payload: { ...base.payload, member_account_id: "stranger" } },
      { ...base, payload: { ...base.payload, member_account_id: "owner" } },
      { ...base, payload: { ...base.payload, peer_key: "not permitted" } },
    ];
    for (const message of invalid) {
      expect(await h.deliver(message as MailboxMessage)).toMatchObject([{ ok: false }]);
    }
    expect(write).not.toHaveBeenCalled();
    expect(await h.deliver(base)).toMatchObject([{ ok: true }]);
    expect(
      await h.claw.authority.submit(
        await h.claw.sign({ op: "remove", account_id: "member" }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    expect(h.claw.authority.current()?.member_browser_requests).toEqual({});
    write.mockClear();
    expect(await h.deliver(base)).toMatchObject([{ ok: false, code: "not_member" }]);
    expect(write).not.toHaveBeenCalled();
  });

  it("bounds replacement and cancellation history and keeps expiry on the local People clock", async () => {
    const h = await setup();
    const { service } = serviceFor(h.claw.authority);
    const start = nowSeconds();
    try {
      for (const char of ["a", "b", "c"]) {
        const message = h.mail(char.repeat(32));
        expect(await h.deliver(message)).toMatchObject([{ ok: true }]);
        expect((await service.linkStatus()).browserRequests).toHaveLength(1);
        if (message.payload.kind !== "member_browser_request") {
          throw new Error("fixture");
        }
        if (char === "c") {
          message.payload.action = "cancel";
          expect(await h.deliver(message)).toMatchObject([{ ok: true }]);
        }
      }
      expect(await h.deliver(h.mail("a".repeat(32)))).toMatchObject([
        { ok: false, code: "replayed" },
      ]);
      expect(await h.deliver(h.mail("d".repeat(32)))).toMatchObject([
        { ok: false, code: "rate_limited" },
      ]);
      vi.spyOn(Date, "now").mockReturnValue((start + 1801) * 1000);
      const message = h.mail("d".repeat(32));
      expect(await h.deliver(message)).toMatchObject([{ ok: true }]);
      expect(h.claw.authority.nextPeopleExpiry()).toBe(start + 3601);
      vi.spyOn(Date, "now").mockReturnValue((start + 3601) * 1000);
      expect((await service.linkStatus()).browserRequests).toEqual([]);
      expect(await h.deliver(message)).toMatchObject([{ ok: false, code: "expired" }]);
    } finally {
      await service.stop();
    }
  });

  it("retires an approved account's notice without refunding its replay receipt", async () => {
    const h = await setup();
    const message = h.mail();
    expect(await h.deliver(message)).toMatchObject([{ ok: true }]);
    const seq = h.claw.authority.current()!.authority!.seq;
    const approved = await h.claw.sign({
      op: "add_member_device",
      account_id: "member",
      label: "Approved browser",
      peer_key: formatIrohEndpointKey(new Uint8Array(32).fill(9)),
      device_pub: formatEd25519PublicKey(new Uint8Array(32).fill(7)),
    });
    expect(await h.claw.authority.submit(approved, "tunnel")).toMatchObject({ ok: true });
    expect(h.claw.authority.current()?.member_browser_requests?.member?.notice).toBeNull();
    expect(await h.deliver(message)).toMatchObject([{ ok: false, code: "replayed" }]);
    expect(h.claw.authority.current()!.authority!.seq).toBe(seq + 1);
    const delayed = h.mail("b".repeat(32));
    expect(
      await h.deliver({
        ...delayed,
        payload: { ...delayed.payload, action: "cancel" },
      } as MailboxMessage),
    ).toMatchObject([{ ok: true }]);
    expect(await h.deliver(delayed)).toMatchObject([{ ok: false, code: "replayed" }]);
    expect(h.claw.authority.current()!.authority!.seq).toBe(seq + 1);
  });

  it("remembers an early terminal result through delayed delivery without renewing or charging the request budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await setup(),
      start = nowSeconds();
    const message = h.mail();
    const terminal = {
      ...message,
      payload: { ...message.payload, action: "cancel" },
    } as MailboxMessage;
    vi.setSystemTime((start + 600) * 1000);
    expect(await h.deliver(terminal)).toMatchObject([{ ok: true }]);
    const retained = structuredClone(h.claw.authority.current()?.member_browser_requests);
    const write = vi.spyOn(h.store, "write");
    vi.setSystemTime((start + 900) * 1000);
    expect(await h.deliver(terminal)).toMatchObject([{ ok: true }]);
    const renewed = h.mail();
    expect(
      await h.deliver({
        ...renewed,
        payload: { ...renewed.payload, action: "cancel" },
      } as MailboxMessage),
    ).toMatchObject([{ ok: true }]);
    expect(await h.deliver(message)).toMatchObject([{ ok: false, code: "replayed" }]);
    expect(write).not.toHaveBeenCalled();
    expect(h.claw.authority.current()?.member_browser_requests).toEqual(retained);
    expect(retained?.member).toMatchObject({
      notice: null,
      recent: [],
      terminal: [{ requestId: "a".repeat(32), until: start + 1800 }],
    });
    for (const char of ["b", "c", "d"]) {
      expect(await h.deliver(h.mail(char.repeat(32)))).toMatchObject([{ ok: true }]);
    }
    expect(await h.deliver(h.mail("e".repeat(32)))).toMatchObject([
      { ok: false, code: "rate_limited" },
    ]);
    vi.setSystemTime((start + 1800) * 1000);
    expect(await h.deliver(message)).toMatchObject([{ ok: false, code: "expired" }]);
  });

  it("bounds unknown terminal IDs without evicting receipts and keeps matching cleanup available at saturation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await setup(),
      start = nowSeconds();
    for (const char of ["a", "b", "c"]) {
      expect(await h.deliver(h.mail(char.repeat(32)))).toMatchObject([{ ok: true }]);
    }
    const recent = structuredClone(
      h.claw.authority.current()?.member_browser_requests?.member?.recent,
    );
    vi.setSystemTime((start + 100) * 1000);
    for (const char of ["d", "e", "f", "0", "1"]) {
      const mail = h.mail(char.repeat(32));
      expect(
        await h.deliver({
          ...mail,
          payload: { ...mail.payload, action: "cancel" },
        } as MailboxMessage),
      ).toMatchObject([{ ok: true }]);
    }
    const entry = h.claw.authority.current()?.member_browser_requests?.member;
    expect(entry).toMatchObject({
      recent,
      notice: { requestId: "c".repeat(32) },
      blockedUntil: start + 1900,
    });
    expect(entry?.terminal).toHaveLength(3);
    const overflow = h.mail("0".repeat(32));
    const write = vi.spyOn(h.store, "write");
    vi.setSystemTime((start + 200) * 1000);
    expect(
      await h.deliver({
        ...overflow,
        payload: { ...overflow.payload, action: "cancel" },
      } as MailboxMessage),
    ).toMatchObject([{ ok: true }]);
    expect(write).not.toHaveBeenCalled();
    expect(await h.deliver(h.mail("a".repeat(32)))).toMatchObject([
      { ok: false, code: "replayed" },
    ]);
    expect(await h.deliver(h.mail("c".repeat(32)))).toMatchObject([{ ok: true }]);
    const matching = h.mail("c".repeat(32));
    expect(
      await h.deliver({
        ...matching,
        payload: { ...matching.payload, action: "cancel" },
      } as MailboxMessage),
    ).toMatchObject([{ ok: true }]);
    expect(h.claw.authority.current()?.member_browser_requests?.member?.notice).toBeNull();
    vi.setSystemTime((start + 1801) * 1000);
    expect(await h.deliver(h.mail("0".repeat(32)))).toMatchObject([
      { ok: false, code: "rate_limited" },
    ]);
    vi.setSystemTime((start + 1901) * 1000);
    expect(await h.deliver(h.mail("2".repeat(32)))).toMatchObject([{ ok: true }]);
    expect(h.claw.authority.current()?.member_browser_requests?.member).toMatchObject({
      terminal: [],
      blockedUntil: null,
    });
  });

  it("invalidates People at notice expiry without any signed authority change", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const h = await setup();
    const { service } = serviceFor(h.claw.authority);
    try {
      await service.linkStatus();
      const changed = vi.fn();
      service.onPeopleChanged(changed);
      const before = structuredClone(h.claw.authority.current()!.authority);
      expect(await h.deliver(h.mail())).toMatchObject([{ ok: true }]);
      expect(changed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1800_000);
      expect(changed).toHaveBeenCalledTimes(2);
      expect((await service.linkStatus()).browserRequests).toEqual([]);
      expect(h.claw.authority.current()!.authority).toEqual(before);
    } finally {
      await service.stop();
    }
  });
});
