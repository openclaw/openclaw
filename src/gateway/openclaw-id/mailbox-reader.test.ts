import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxMessage } from "../../../packages/openclaw-id-protocol/src/index.js";
import { applyMailboxMessage, startMailboxReader } from "./mailbox-reader.js";

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
