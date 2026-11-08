import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  ROOT_EPOCH,
  signStatement,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { applyMailboxMessage, startMailboxReader } from "./mailbox-reader.js";
import { linkedClaw, redemptionMail } from "./openclaw-id.test-support.js";

const rootMail: MailboxMessage = {
  message_id: "m1",
  claw_id: "c1",
  to: "gateway",
  from: {
    account_id: "a",
    email: null,
    display_name: null,
    device_fp: "fp:dev",
    reported_by: "openclaw-id",
  },
  location_hint: null,
  payload: { kind: "root_statement", statements: [{} as never] },
  received_at: 0,
  expires_at: 0,
};

describe("mailbox reader callbacks", () => {
  let reader: { stop(): void } | undefined;
  afterEach(() => {
    reader?.stop();
    vi.useRealTimers();
  });

  it("reports the first read and each recovery as connected, and refusals with their message", async () => {
    vi.useFakeTimers();
    const replies: Array<() => Promise<unknown>> = [
      async () => ({ messages: [], cursor: "1" }),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => ({ messages: [rootMail], cursor: "2" }),
    ];
    const client = {
      receiveMail: vi.fn(async () =>
        replies.length > 0 ? await replies.shift()!() : await new Promise(() => {}),
      ),
      ackMail: vi.fn(async () => {}),
    };
    const onConnected = vi.fn();
    const onRefused = vi.fn(async () => {});
    reader = startMailboxReader({
      clawId: "c1",
      client: client as never,
      cursor: null,
      sink: {
        submit: async () => ({ ok: false, code: "seq_conflict", detail: "expected seq 3" }),
        redeem: vi.fn(),
        saveCursor: async () => {},
      },
      onEffects: async () => {},
      onRefused,
      onConnected,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(onRefused).toHaveBeenCalledWith(rootMail, {
      ok: false,
      code: "seq_conflict",
      detail: "expected seq 3",
    });
    expect(client.ackMail).toHaveBeenCalledWith("c1", "2");
  });

  it("settles unsupported node mail before acknowledging and saving its cursor", async () => {
    const node = await generateEd25519Signer();
    const message: MailboxMessage = {
      ...rootMail,
      from: {
        ...rootMail.from,
        account_id: null,
        email: null,
        display_name: null,
        device_fp: await fingerprint(formatEd25519PublicKey(node.publicKey)),
      },
      payload: {
        kind: "node_redemption",
        redemption: await signStatement(
          "NodeRedemption",
          {
            claw_id: "a".repeat(32),
            invite_id: "b".repeat(32),
            peer_key: formatIrohEndpointKey(node.publicKey),
            requested_at: 0,
            proof: "0".repeat(64),
            description: { display_name: "node", platform: "linux", commands: [], caps: [] },
          },
          node,
        ),
      },
    };
    const order: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    const submit = vi.fn();
    const redeem = vi.fn();
    const onRefused = vi.fn(async () => {
      order.push("refused");
    });
    reader = startMailboxReader({
      clawId: "c1",
      cursor: null,
      client: {
        receiveMail: vi
          .fn()
          .mockResolvedValueOnce({ messages: [message], cursor: "2" })
          .mockImplementation(() => new Promise(() => {})),
        ackMail: async () => {
          order.push("ack");
        },
      } as never,
      sink: {
        submit,
        redeem,
        saveCursor: async () => {
          order.push("cursor");
          resolve();
        },
      },
      onEffects: vi.fn(),
      onRefused,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    await promise;
    expect(onRefused).toHaveBeenCalledExactlyOnceWith(message, {
      ok: false,
      code: "unsupported",
      detail: "node enrollment is not enabled in this Gateway",
    });
    expect(order).toEqual(["refused", "ack", "cursor"]);
    expect(submit).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
  });

  it("applies nothing from a batch that arrives after stop", async () => {
    let release: (batch: unknown) => void = () => {};
    const client = {
      receiveMail: vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
      ackMail: vi.fn(async () => {}),
    };
    const submit = vi.fn(async () => ({ ok: false as const, code: "unused", detail: "unused" }));
    reader = startMailboxReader({
      clawId: "c1",
      client: client as never,
      cursor: null,
      sink: { submit, redeem: vi.fn(), saveCursor: vi.fn(async () => {}) },
      onEffects: vi.fn(async () => {}),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    await vi.waitFor(() => expect(client.receiveMail).toHaveBeenCalled());
    reader.stop();
    release({ messages: [rootMail], cursor: "2" });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(submit).not.toHaveBeenCalled();
    expect(client.ackMail).not.toHaveBeenCalled();
  });

  it("settles a committed statement's effects before a later statement fails", async () => {
    const message = {
      ...rootMail,
      payload: { kind: "root_statement" as const, statements: [{} as never, {} as never] },
    };
    const removal = [{ type: "disconnect" as const, peer_keys: ["iroh:bob"] }];
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: "accepted", events: removal })
      .mockRejectedValueOnce(new Error("disk full"));
    const settled: unknown[] = [];
    await expect(
      applyMailboxMessage(message, { submit, redeem: vi.fn() }, async (result) => {
        settled.push(result);
      }),
    ).rejects.toThrow("disk full");
    expect(settled).toEqual([{ ok: true, status: "accepted", events: removal }]);
  });

  it("submits no further statement of a message once the reader is stopped", async () => {
    const message = {
      ...rootMail,
      payload: { kind: "root_statement" as const, statements: [{} as never, {} as never] },
    };
    const stop = new AbortController();
    const submit = vi.fn(async () => ({
      ok: true as const,
      status: "applied" as const,
      events: [],
    }));
    await applyMailboxMessage(
      message,
      { submit, redeem: vi.fn() },
      async () => {
        // Remote access is turned off while the first statement's effects settle.
        stop.abort();
      },
      stop.signal,
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

it("settles accountless member redemptions as refused without blocking the next valid message", async () => {
  const { message } = await redemptionMail({
    clawId: "a".repeat(32),
    inviteId: "b".repeat(32),
    proofKey: new Uint8Array(32),
    accountId: "acct-bob",
    email: "bob@example.test",
  });
  const accountless: MailboxMessage = {
    ...message,
    from: {
      ...message.from,
      account_id: null,
      email: null,
      display_name: null,
      device_fp: "fp:node",
    },
  };
  const refused = {
    ok: false,
    code: "audience_mismatch",
    detail: "redeeming account is not the invite audience",
  };
  const accepted = { ok: true as const, status: "pending" as const, events: [] };
  const redeem = vi.fn(async () => accepted);
  const submit = vi.fn();
  const settle = vi.fn(async () => {});
  expect(await applyMailboxMessage(accountless, { redeem, submit }, settle)).toEqual([refused]);
  expect(settle).toHaveBeenCalledWith(refused);
  expect(redeem).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(await applyMailboxMessage(message, { redeem, submit }, settle)).toEqual([accepted]);
  expect(redeem).toHaveBeenCalledExactlyOnceWith(message.payload.redemption, {
    account_id: "acct-bob",
    email: "bob@example.test",
    display_name: "Bob",
    location_hint: message.location_hint,
  });
});

describe("mailbox revocation replay", () => {
  it("refuses a captured revocation replayed after the device is approved again", async () => {
    const claw = await linkedClaw();
    const now = Math.floor(Date.now() / 1000);
    const laptop = await generateEd25519Signer();
    const peer = formatIrohEndpointKey(randomBytes(32));
    const body = {
      device_pub: formatEd25519PublicKey(laptop.publicKey),
      peer_keys: [peer],
      label: "laptop",
      scope: "owner" as const,
      caps: [...OWNER_CAPABILITIES],
      issued_at: now,
      expires_at: null,
      root_epoch: ROOT_EPOCH,
    };
    const cert = await signStatement("OwnerDeviceCert", body, claw.device);
    const approve = async () =>
      expect(
        await claw.authority.submit(await claw.sign({ op: "add_owner_device", cert }), "tunnel"),
      ).toMatchObject({ ok: true });
    await approve();
    const revocation = await signStatement(
      "Revocation",
      {
        claw_id: claw.clawId,
        seq: (await claw.authority.load())!.authority!.seq,
        target_fp: await fingerprint(body.device_pub),
        target_kind: "owner_device" as const,
        reason: "lost",
        root_epoch: ROOT_EPOCH,
        issued_at: now,
      },
      claw.device,
    );
    const message = {
      ...rootMail,
      claw_id: claw.clawId,
      payload: { kind: "revocation" as const, revocation },
    };
    const sink = { submit: (s: unknown) => claw.authority.submit(s, "mailbox"), redeem: vi.fn() };
    const [removed] = await applyMailboxMessage(message, sink);
    expect(removed).toMatchObject({ ok: true });
    expect(removed?.ok && removed.events).toContainEqual({
      type: "invalidate_tokens",
      peer_keys: [peer],
    });
    await approve();
    const [replayed] = await applyMailboxMessage(message, sink);
    expect(replayed).toMatchObject({ ok: false, code: "seq_conflict" });
    expect((await claw.authority.admittedPeerKeys()).admitted).toContain(peer);
  });
});
