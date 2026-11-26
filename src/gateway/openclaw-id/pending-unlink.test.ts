import { afterEach, expect, it, vi } from "vitest";
import {
  generateEd25519Signer,
  signStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import { createPendingUnlinkSender } from "./pending-unlink.js";

afterEach(() => {
  vi.useRealTimers();
});

// One pending unlink and a sender over it; `answers` are Discovery's responses in order.
async function setup(answers: Array<() => Response>) {
  const signer = await generateEd25519Signer();
  const statement = await signStatement(
    "ClawUnlink",
    { claw_id: "a".repeat(32), binding_seq: 1 },
    signer,
  );
  let record = {
    pending_unlinks: [
      { statement, hostname: "studio-k7x2q.example.test", discovery_url: "https://d.test" },
    ],
  } as Partial<StoredClaw>;
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const answer = answers.shift();
    if (!answer) {
      throw new TypeError("fetch failed");
    }
    return answer();
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const sender = createPendingUnlinkSender({
    // SAFETY: the sender reads only pending_unlinks.
    current: () => record as StoredClaw,
    settle: async (settled, outcome) => {
      const kept = record.pending_unlinks!.flatMap((pending) =>
        pending.statement.body.claw_id !== settled.body.claw_id
          ? [pending]
          : outcome.kind === "confirmed"
            ? []
            : [{ ...pending, refused: outcome.code }],
      );
      record = kept.length ? { pending_unlinks: kept } : {};
    },
    signer: async () => signer,
    log,
    fetchImpl,
    initialDelayMs: 1_000,
    random: () => 1,
  });
  const enqueue = async () => {
    const pending = record.pending_unlinks![0]!;
    const queued = await signStatement(
      "ClawUnlink",
      { claw_id: "b".repeat(32), binding_seq: 1 },
      signer,
    );
    record = { pending_unlinks: [...record.pending_unlinks!, { ...pending, statement: queued }] };
  };
  return { sender, fetchImpl, log, enqueue, pending: () => record.pending_unlinks };
}

it("keeps an unlink Discovery could not take and sends it again after the backoff", async () => {
  vi.useFakeTimers();
  const { sender, fetchImpl, pending } = await setup([
    () => Response.json({ error: { code: "unavailable", message: "down" } }, { status: 503 }),
    () => Response.json({ claw_id: "a".repeat(32), hostname: "h", unlinked_at: 1 }),
  ]);
  await sender.start();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(pending()).toHaveLength(1);
  await sender.start();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  // Request signing uses WebCrypto, which settles outside the fake clock.
  await vi.waitFor(() => expect(pending()).toBeUndefined());
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  sender.stop();
});

it("keeps an unlink Discovery refused for good as refused and does not send it again", async () => {
  const { sender, fetchImpl, log, pending } = await setup([
    () => Response.json({ error: { code: "invalid_statement", message: "x" } }, { status: 400 }),
  ]);
  await sender.start();
  expect(pending()).toEqual([expect.objectContaining({ refused: "invalid_statement" })]);
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("(invalid_statement)"));
  await sender.start();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  sender.stop();
});

it("sends again when started after a stop that cut a send short", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { sender, fetchImpl, pending } = await setup([]);
  fetchImpl.mockImplementationOnce(async () => {
    await held;
    throw new TypeError("fetch failed");
  });
  fetchImpl.mockImplementationOnce(async () =>
    Response.json({ claw_id: "a".repeat(32), hostname: "h", unlinked_at: 1 }),
  );
  const first = sender.start();
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  sender.stop();
  const second = sender.start();
  release();
  await Promise.all([first, second]);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(pending()).toBeUndefined();
  sender.stop();
});

it("sends a newly committed unlink at once, without waiting on an older stalled one", async () => {
  const held = Promise.withResolvers<Response>();
  const { sender, fetchImpl, enqueue, pending } = await setup([
    () => Response.json({ claw_id: "b".repeat(32), hostname: "h", unlinked_at: 1 }),
  ]);
  fetchImpl.mockImplementationOnce(() => held.promise);
  const first = sender.start();
  try {
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await enqueue();
    // The older unlink's request is still open; the new one is sent and settled regardless.
    await sender.flush(pending()![1]!.statement);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pending()?.map((entry) => entry.statement.body.claw_id)).toEqual(["a".repeat(32)]);
    held.resolve(Response.json({ claw_id: "a".repeat(32), hostname: "h", unlinked_at: 1 }));
    await first;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pending()).toBeUndefined();
  } finally {
    sender.stop();
  }
});

it("retries a flush that failed during a run once that run ends", async () => {
  const held = Promise.withResolvers<Response>();
  const { sender, fetchImpl, enqueue, pending } = await setup([
    () => Response.json({ error: { code: "unavailable", message: "down" } }, { status: 503 }),
    () => Response.json({ claw_id: "b".repeat(32), hostname: "h", unlinked_at: 1 }),
  ]);
  fetchImpl.mockImplementationOnce(() => held.promise);
  const first = sender.start();
  try {
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await enqueue();
    await sender.flush(pending()![1]!.statement);
    held.resolve(Response.json({ claw_id: "a".repeat(32), hostname: "h", unlinked_at: 1 }));
    await first;
    await vi.waitFor(() => expect(pending()).toBeUndefined(), { timeout: 3_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  } finally {
    sender.stop();
  }
});

it("retries a flush cut short by a stop and restart", async () => {
  const { sender, fetchImpl, pending } = await setup([
    () => Response.json({ claw_id: "a".repeat(32), hostname: "h", unlinked_at: 1 }),
  ]);
  fetchImpl.mockImplementationOnce(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  const flush = sender.flush(pending()![0]!.statement);
  try {
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    sender.stop();
    await sender.start();
    await flush;
    await vi.waitFor(() => expect(pending()).toBeUndefined(), { timeout: 3_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    sender.stop();
  }
});
